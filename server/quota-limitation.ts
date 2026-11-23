import { activeExhausted } from "./engine";
import { isActive, type Run } from "../shared/types";
import type { QuotaLimitation, QuotaProject, QuotaProvider, QuotaWindow } from "../shared/quota-limitation";
import type { RateLimitsConfig } from "./config";
import { windowKey } from "./rate-budget";
import { admittedRunIds, runningStepCount, usedPct, windowRooms, type PacerView } from "./rate-limit";
import { windowModel } from "./usage";

/** A reservation as the runtime keeps it: points still to use per `windowKey`. */
export interface ReservationView {
  runId: string;
  est: Record<string, number>;
  spent: Record<string, number>;
  endedAt: number | null;
}

/** A project with the limits its runs get, one entry per distinct set among its playbooks (`resolveQuotaLimits`: folder defaults, user config, built-in). */
export interface ProjectLimitsInput {
  projectId: string;
  label: string;
  sets: Array<{ repos: string[]; config: RateLimitsConfig }>;
}

const round = (value: number) => Math.round(value * 10) / 10;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * What the Quota limitation tab shows: the limits each project's runs get, and for each provider the pacing tracks: its usage
 * windows and the numbers the pacing decides from (usage, pace ceiling, reservations, headroom), the runs held or paused for pace
 * and the exhausted marks. The usage and reservations are global per provider; the pace ceiling, headroom and free share are
 * given for each distinct `usable_percent` among the projects with pacing on. Read-only: it recomputes the figures from the same
 * pieces the admission uses.
 */
export function buildQuotaLimitation(input: { projects: ProjectLimitsInput[]; nowMs: number; views: PacerView[]; runs: Run[]; reservations: ReservationView[] }): QuotaLimitation {
  const { projects, nowMs, views, runs, reservations } = input;
  /** The distinct usable percents of the projects that pace, with their labels. */
  const pacing = new Map<number, string[]>();
  for (const project of projects) {
    for (const percent of new Set(project.sets.filter((set) => set.config.quota.pacing).map((set) => set.config.quota.usablePercent))) {
      pacing.set(percent, [...(pacing.get(percent) ?? []), project.label]);
    }
  }
  const pacedBy = [...new Set([...pacing.values()].flat())];
  const live = runs.filter((run) => !run.archivedAt && isActive(run));
  const titleOf = (run: Run) => run.playbook.title;
  const remaining = (reservation: ReservationView, key: string) => Math.max(0, (reservation.est[key] ?? 0) - (reservation.spent[key] ?? 0));
  const open = reservations.filter((reservation) => reservation.endedAt === null);

  const providers: QuotaProvider[] = views.map((view) => {
    const rooms = view.entry ? [...pacing].map(([percent, labels]) => ({ percent, labels, rooms: windowRooms(view.entry!, percent, nowMs) })) : [];
    const windows: QuotaWindow[] = (view.entry?.windows ?? []).map((window) => {
      const key = windowKey(view.provider, window.id);
      const reserved = round(open.reduce((total, reservation) => total + remaining(reservation, key), 0));
      const used = usedPct(window);
      const resets = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      return {
        id: window.id,
        name: window.label ?? window.id,
        modelScoped: windowModel(window.id) !== null,
        used: used === null ? null : round(used),
        reserved,
        paces: rooms.flatMap(({ percent, labels, rooms: list }) => {
          const room = list.find((candidate) => candidate.id === window.id);
          if (!room) return [];
          const headroom = round(room.ceiling - room.used);
          return [{ usable: percent, ceiling: round(room.ceiling), headroom, free: round(headroom - reserved), projects: labels }];
        }),
        resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : null,
        stale: Number.isFinite(resets) && resets <= nowMs,
      };
    });
    const mine = open.filter((reservation) => Object.keys(reservation.est).some((key) => key.startsWith(`${view.provider}\u0000`)));
    return {
      provider: view.provider,
      pacedBy,
      state: view.state,
      readAt: iso(view.readAt),
      overrideUntil: iso(view.overrideUntil),
      windows,
      reservations: mine.flatMap((reservation) => {
        const run = runs.find((candidate) => candidate.id === reservation.runId);
        if (!run) return [];
        const left: Record<string, number> = {};
        for (const key of Object.keys(reservation.est)) {
          const [provider, windowId] = key.split("\u0000");
          const value = remaining(reservation, key);
          if (provider === view.provider && windowId && value > 0) left[windowId] = round(value);
        }
        return [{ runId: run.id, projectId: run.projectId, title: titleOf(run), remaining: left }];
      }),
      held: live.flatMap((run) => (run.rateHold && run.rateHold.provider === view.provider ? [{ runId: run.id, projectId: run.projectId, title: titleOf(run), kind: run.rateHold.kind, reason: run.rateHold.reason, window: run.rateHold.window, retryAt: run.rateHold.retryAt }] : [])),
      exhausted: live.flatMap((run) =>
        run.exhausted
          .filter((entry) => entry.target === view.provider || entry.target.startsWith(`${view.provider}/`))
          .filter((entry) => activeExhausted({ exhausted: [entry], playbook: run.playbook }, nowMs).length > 0)
          .map((entry) => ({ runId: run.id, projectId: run.projectId, title: titleOf(run), target: entry.target, until: new Date(Date.parse(entry.at) + run.playbook.exhaustedForMs).toISOString() })),
      ),
    };
  });

  const everyone: QuotaProject[] = projects.map(({ projectId, label, sets }) => ({
    projectId,
    label,
    limits: sets.map(({ repos, config }) => ({ repos, pacing: config.quota.pacing, usablePercent: config.quota.usablePercent, stepsLimit: config.steps, runsLimit: config.playbooks })),
  }));
  return {
    now: new Date(nowMs).toISOString(),
    projects: everyone,
    stepsRunning: runningStepCount(runs),
    runsActive: admittedRunIds(runs, Number.MAX_SAFE_INTEGER)?.size ?? 0,
    providers,
    limitHeld: live.flatMap((run) => (run.rateHold && !run.rateHold.provider ? [{ runId: run.id, projectId: run.projectId, title: titleOf(run), kind: run.rateHold.kind, reason: run.rateHold.reason }] : [])),
  };
}
