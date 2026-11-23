import { activeExhausted } from "./engine";
import { isActive, type Run } from "../shared/types";
import type { QuotaLimitation, QuotaProvider, QuotaWindow } from "../shared/quota-limitation";
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

const round = (value: number) => Math.round(value * 10) / 10;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * What the Quota limitation tab shows: for each provider the pacing tracks, its usage windows and the numbers the pacing decides
 * from (usage, pace ceiling, reservations, headroom), the runs held or paused for pace and the exhausted marks. Read-only: it
 * recomputes the figures from the same pieces the admission uses, at the user-level limits (a project's own `usable_percent` can differ).
 */
export function buildQuotaLimitation(input: { config: RateLimitsConfig; nowMs: number; views: PacerView[]; runs: Run[]; reservations: ReservationView[] }): QuotaLimitation {
  const { config, nowMs, views, runs, reservations } = input;
  const live = runs.filter((run) => !run.archivedAt && isActive(run));
  const titleOf = (run: Run) => run.playbook.title;
  const remaining = (reservation: ReservationView, key: string) => Math.max(0, (reservation.est[key] ?? 0) - (reservation.spent[key] ?? 0));
  const open = reservations.filter((reservation) => reservation.endedAt === null);

  const providers: QuotaProvider[] = views.map((view) => {
    const rooms = view.entry ? windowRooms(view.entry, config.quota.usablePercent, nowMs) : [];
    const windows: QuotaWindow[] = (view.entry?.windows ?? []).map((window) => {
      const room = rooms.find((candidate) => candidate.id === window.id);
      const key = windowKey(view.provider, window.id);
      const reserved = round(open.reduce((total, reservation) => total + remaining(reservation, key), 0));
      const used = usedPct(window);
      const resets = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      const headroom = room ? round(room.ceiling - room.used) : null;
      return {
        id: window.id,
        name: window.label ?? window.id,
        modelScoped: windowModel(window.id) !== null,
        used: used === null ? null : round(used),
        usable: config.quota.usablePercent,
        ceiling: room ? round(room.ceiling) : null,
        headroom,
        reserved,
        free: headroom === null ? null : round(headroom - reserved),
        resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : null,
        stale: Number.isFinite(resets) && resets <= nowMs,
      };
    });
    const mine = open.filter((reservation) => Object.keys(reservation.est).some((key) => key.startsWith(`${view.provider}\u0000`)));
    return {
      provider: view.provider,
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
        return [{ runId: run.id, title: titleOf(run), remaining: left }];
      }),
      held: live.flatMap((run) => (run.rateHold && run.rateHold.provider === view.provider ? [{ runId: run.id, title: titleOf(run), kind: run.rateHold.kind, reason: run.rateHold.reason, window: run.rateHold.window, retryAt: run.rateHold.retryAt }] : [])),
      exhausted: live.flatMap((run) =>
        run.exhausted
          .filter((entry) => entry.target === view.provider || entry.target.startsWith(`${view.provider}/`))
          .filter((entry) => activeExhausted({ exhausted: [entry], playbook: run.playbook }, nowMs).length > 0)
          .map((entry) => ({ runId: run.id, title: titleOf(run), target: entry.target, until: new Date(Date.parse(entry.at) + run.playbook.exhaustedForMs).toISOString() })),
      ),
    };
  });

  const admitted = admittedRunIds(runs, config.playbooks);
  return {
    now: new Date(nowMs).toISOString(),
    pacing: config.quota.pacing,
    usablePercent: config.quota.usablePercent,
    refreshSeconds: Math.round(config.quota.refreshMs / 1000),
    maxAgeSeconds: Math.round(config.quota.maxAgeMs / 1000),
    steps: { limit: config.steps, running: runningStepCount(runs) },
    playbooks: { limit: config.playbooks, admitted: admitted ? admitted.size : null },
    providers,
    limitHeld: live.flatMap((run) => (run.rateHold && !run.rateHold.provider ? [{ runId: run.id, title: titleOf(run), kind: run.rateHold.kind, reason: run.rateHold.reason }] : [])),
  };
}
