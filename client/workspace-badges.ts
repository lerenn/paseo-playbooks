import { slowSteps, slowView } from "../shared/slow";
import { waitsForHuman } from "../shared/gates";
import { isActive, isPaused, type RunSummary } from "../shared/types";

/**
 * What the two sidebar badges of a workspace row show, as pure functions of the run summaries
 * (ADR 2026-11-24-sidebar-workspace-badges). The host's badge has five tones (muted, success,
 * warning, danger, info); the plugin's semantic tones (client/semantic-colors.ts) map onto them:
 *
 *   running (blue)   -> info       finished, done (green)  -> success
 *   waiting (orange) -> warning    failed (red)            -> danger
 *   canceled         -> muted
 *
 * Violet (paused, or held by rate limiting, both worded "paused") has no counterpart among the five:
 * it is the plugin's own "violet" tone, drawn by client/workspace-badge-items.tsx.
 */
export type HostBadgeTone = "muted" | "success" | "warning" | "danger" | "info";
export type BadgeTone = HostBadgeTone | "violet";

export type RunBadgeState = "running" | "waiting" | "held" | "paused" | "done" | "failed" | "canceled";

export const STATE_TONES: Readonly<Record<RunBadgeState, BadgeTone>> = {
  running: "info",
  waiting: "warning",
  held: "violet",
  paused: "violet",
  done: "success",
  failed: "danger",
  canceled: "muted",
};

/** A run that ended longer ago than this no longer marks its workspace. */
export const RECENT_MS = 24 * 3_600_000;

export interface RunBadge {
  runId: string;
  state: RunBadgeState;
  tone: BadgeTone;
  /** Main steps completed, and how many there are. */
  done: number;
  total: number;
  /** The playbook's title, for the accessibility label. */
  playbook: string;
}

export type AttentionKind = "gate" | "slow";

export interface AttentionBadge {
  kind: AttentionKind;
  tone: HostBadgeTone;
}

/** What a workspace row shows: its run's badge, and the attention badge when something needs the user. */
export interface WorkspaceBadges {
  run: RunBadge;
  attention: AttentionBadge | null;
}

/** The steps that count in "3/7": the main ones, without after-tasks and the branches that were not taken. */
function mainSteps(run: RunSummary) {
  return run.playbook.steps.filter((step) => !step.afterTask && !(step.when && run.steps[step.id]?.status === "skipped"));
}

function stateOf(run: RunSummary): RunBadgeState {
  if (run.status === "completed") return isActive(run) ? "running" : "done";
  if (run.status === "failed") return "failed";
  if (run.status === "canceled") return "canceled";
  if (isPaused(run)) return "paused";
  if (run.gates.some(waitsForHuman)) return "waiting";
  const stepStatuses = Object.values(run.steps).map((step) => step.status);
  if (run.rateHold) return stepStatuses.includes("running") ? "running" : "held";
  if (stepStatuses.includes("running")) return "running";
  if (stepStatuses.includes("queued")) return "waiting";
  return "running";
}

export function runBadge(run: RunSummary): RunBadge {
  const state = stateOf(run);
  const steps = mainSteps(run);
  return {
    runId: run.id,
    state,
    tone: STATE_TONES[state],
    done: steps.filter((step) => run.steps[step.id]?.status === "completed").length,
    total: steps.length,
    playbook: run.playbook.title ?? run.playbook.id,
  };
}

/**
 * Why an active run needs the user, most urgent first; null when it does not. `slow`: some step is slower than usual.
 * A run held by rate limiting with nothing running needs nothing from the user: only the run badge shows it.
 */
export function attentionOf(run: RunSummary, slow: boolean): AttentionBadge | null {
  if (!isActive(run) || run.status === "failed" || run.status === "canceled") return null;
  if (run.gates.some(waitsForHuman)) return { kind: "gate", tone: "danger" };
  if (slow) return { kind: "slow", tone: "warning" };
  return null;
}

const URGENCY: Record<AttentionKind, number> = { gate: 0, slow: 1 };

function ended(run: RunSummary): number {
  const time = Date.parse(run.updatedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Which of two runs of one workspace marks it: an active one before a finished one, then the most recently updated. */
function better(a: RunSummary, b: RunSummary): boolean {
  const activeA = isActive(a);
  if (activeA !== isActive(b)) return activeA;
  return ended(a) > ended(b);
}

/**
 * The badges of every workspace with an active or recent run, by workspace id. A run is recent for
 * RECENT_MS after its last update. With several runs in one workspace the active, then the latest
 * one gives the run badge; the attention badge takes the most urgent need among the active ones.
 */
export function indexBadges(runs: readonly RunSummary[], now: number): Map<string, WorkspaceBadges> {
  const history = runs.map(slowView);
  const chosen = new Map<string, RunSummary>();
  const attention = new Map<string, AttentionBadge>();
  for (const run of runs) {
    if (!isActive(run) && now - ended(run) > RECENT_MS) continue;
    const current = chosen.get(run.workspaceId);
    if (!current || better(run, current)) chosen.set(run.workspaceId, run);
    if (!isActive(run)) continue;
    const slow = Object.keys(slowSteps(slowView(run), history, now)).length > 0;
    const need = attentionOf(run, slow);
    const known = attention.get(run.workspaceId);
    if (need && (!known || URGENCY[need.kind] < URGENCY[known.kind])) attention.set(run.workspaceId, need);
  }
  const index = new Map<string, WorkspaceBadges>();
  for (const [workspaceId, run] of chosen) index.set(workspaceId, { run: runBadge(run), attention: attention.get(workspaceId) ?? null });
  return index;
}
