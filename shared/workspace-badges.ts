import { z } from "zod";
import { slowSteps, slowView } from "./slow";
import { waitsForHuman } from "./gates";
import { isActive, isPaused, isPipeline, type Run, type RunSummary } from "./types";

const SemanticToneSchema = z.enum(["running", "waiting", "done", "failed", "paused"]);
export type SemanticTone = z.infer<typeof SemanticToneSchema>;
type BadgeRun = Run | RunSummary;

/**
 * What the two sidebar badges of a workspace row show, as pure functions of the run summaries
 * (ADR 2026-11-24-sidebar-workspace-badges). The host's badge has five tones (muted, success,
 * warning, danger, info); the plugin's semantic tones (client/semantic-colors.ts) map onto them:
 *
 *   running (blue)   -> info       finished, done (green)  -> success
 *   waiting (orange) -> warning    failed (red)            -> danger
 *   canceled         -> muted
 *
 * A pipeline (a singleton's long-lived run) with no open job, none in a batch and none waiting, is "ready"
 * (green, `CircleCheck`): its run badge is the bare workflow icon, with no step count. Three badges: the run's (workflow icon and "3/7" while the run is live, a word once it ended), the
 * state's (an icon and a word: running, paused, waiting) and the attention one (gate, slow). Violet
 * (paused, or held by rate limiting, both worded "paused") has no counterpart among the five: it is
 * the plugin's own "violet" tone, drawn by client/workspace-badge-items.tsx. One meaning never shows
 * twice: a run that waits at a gate shows the attention badge, not a "waiting" state badge.
 */
const HostBadgeToneSchema = z.enum(["muted", "success", "warning", "danger", "info"]);
const BadgeToneSchema = HostBadgeToneSchema.or(z.literal("violet"));
const RunBadgeStateSchema = z.enum(["ready", "running", "waiting", "held", "paused", "done", "failed", "canceled"]);
type HostBadgeTone = z.infer<typeof HostBadgeToneSchema>;
export type BadgeTone = z.infer<typeof BadgeToneSchema>;
type RunBadgeState = z.infer<typeof RunBadgeStateSchema>;

/**
 * The row's colour: one semantic state per row, applied to ALL our badges on it (the leading dot stays muted grey)
 * (running blue, waiting or needing the user orange, paused or held violet, done green, failed red; canceled
 * has none and stays muted). The host's tones cannot express violet or a fixed orange, so a row with a colour
 * is always drawn by the plugin's own badge.
 */
export const STATE_ROW_TONES: Readonly<Record<RunBadgeState, SemanticTone | null>> = {
  ready: "done",
  running: "running",
  waiting: "waiting",
  held: "paused",
  paused: "paused",
  done: "done",
  failed: "failed",
  canceled: null,
};

export const STATE_TONES: Readonly<Record<RunBadgeState, HostBadgeTone>> = {
  ready: "success",
  running: "info",
  waiting: "warning",
  // A live run's badge only carries the step count, its state is the state badge's: paused stays neutral.
  held: "muted",
  paused: "muted",
  done: "success",
  failed: "danger",
  canceled: "muted",
};

/** A run that ended longer ago than this no longer marks its workspace. */
export const RECENT_MS = 24 * 3_600_000;

const RunBadgeSchema = z.object({
  runId: z.string(),
  state: RunBadgeStateSchema,
  tone: HostBadgeToneSchema,
  /** True while the label is a step count. */
  live: z.boolean(),
  done: z.number().int(),
  total: z.number().int(),
  /** The playbook's title, for the accessibility label. */
  playbook: z.string(),
});

const StateBadgeSchema = z.object({
  kind: z.enum(["ready", "running", "paused", "waiting"]),
  tone: BadgeToneSchema,
  /** A Lucide icon name. */
  icon: z.string(),
});

type RunBadge = z.infer<typeof RunBadgeSchema>;
type StateBadge = z.infer<typeof StateBadgeSchema>;
type StateKind = StateBadge["kind"];

const STATE_BADGES: Readonly<Record<StateKind, StateBadge>> = {
  ready: { kind: "ready", tone: "success", icon: "CircleCheck" },
  running: { kind: "running", tone: "info", icon: "Play" },
  paused: { kind: "paused", tone: "violet", icon: "Pause" },
  waiting: { kind: "waiting", tone: "warning", icon: "Hourglass" },
};

const AttentionBadgeSchema = z.object({
  kind: z.enum(["gate", "slow"]),
  tone: HostBadgeToneSchema,
});

type AttentionBadge = z.infer<typeof AttentionBadgeSchema>;
type AttentionKind = AttentionBadge["kind"];

/** What a workspace sidebar row shows. */
export const WorkspaceBadgesSchema = z.object({
  /** An open gate on the workspace makes the row "waiting". */
  rowTone: SemanticToneSchema.nullable(),
  run: RunBadgeSchema,
  /** Null for ended runs and those waiting at a gate. */
  state: StateBadgeSchema.nullable(),
  attention: AttentionBadgeSchema.nullable(),
});

export type WorkspaceBadges = z.infer<typeof WorkspaceBadgesSchema>;

/** The steps that count in "3/7": the main ones, without after-tasks and the branches that were not taken. */
function mainSteps(run: BadgeRun) {
  return run.playbook.steps.filter((step) => !step.afterTask && !(step.when && run.steps[step.id]?.status === "skipped"));
}

function stateOf(run: BadgeRun): RunBadgeState {
  if (run.status === "completed") return isActive(run) ? "running" : "done";
  if (run.status === "failed") return "failed";
  if (run.status === "canceled") return "canceled";
  if (isPaused(run)) return "paused";
  if (run.gates.some(waitsForHuman)) return "waiting";
  if (isPipeline(run)) {
    // A long-lived pipeline between jobs is ready, not running. With jobs it is running while one is in a batch, else waiting.
    const open = run.jobs.filter((job) => job.status === "open");
    if (open.length === 0) return "ready";
    return open.some((job) => job.waiting.length === 0) ? "running" : "waiting";
  }
  const stepStatuses = Object.values(run.steps).map((step) => step.status);
  if (run.rateHold) return stepStatuses.includes("running") ? "running" : "held";
  if (stepStatuses.includes("running")) return "running";
  if (stepStatuses.includes("queued")) return "waiting";
  return "running";
}

/** The state badge of a run: null once it ended, and while it waits at a gate (the `gate` attention badge says that). */
export function stateBadge(run: BadgeRun): StateBadge | null {
  const state = stateOf(run);
  if (state === "done" || state === "failed" || state === "canceled") return null;
  if (state === "waiting" && run.gates.some(waitsForHuman)) return null;
  return STATE_BADGES[state === "held" ? "paused" : state];
}

export function runBadge(run: BadgeRun): RunBadge {
  const state = stateOf(run);
  const steps = mainSteps(run);
  return {
    runId: run.id,
    state,
    tone: STATE_TONES[state],
    live: state !== "done" && state !== "failed" && state !== "canceled",
    done: steps.filter((step) => run.steps[step.id]?.status === "completed").length,
    total: steps.length,
    playbook: run.playbook.title ?? run.playbook.id,
  };
}

/**
 * Why an active run needs the user, most urgent first; null when it does not. `slow`: some step is slower than usual.
 * A run held by rate limiting with nothing running needs nothing from the user: only the run badge shows it.
 */
export function attentionOf(run: BadgeRun, slow: boolean): AttentionBadge | null {
  if (!isActive(run) || run.status === "failed" || run.status === "canceled") return null;
  if (run.gates.some(waitsForHuman)) return { kind: "gate", tone: "danger" };
  if (slow) return { kind: "slow", tone: "warning" };
  return null;
}

const URGENCY: Record<AttentionKind, number> = { gate: 0, slow: 1 };

function ended(run: BadgeRun): number {
  const time = Date.parse(run.updatedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Which of two runs of one workspace marks it: an active one before a finished one, then the most recently updated. */
function better(a: BadgeRun, b: BadgeRun): boolean {
  const activeA = isActive(a);
  if (activeA !== isActive(b)) return activeA;
  return ended(a) > ended(b);
}

/**
 * The badges of every workspace with an active or recent run, by workspace id. A run is recent for
 * RECENT_MS after its last update. With several runs in one workspace the active, then the latest
 * one gives the run badge; the attention badge takes the most urgent need among the active ones.
 */
export function indexBadges(runs: readonly BadgeRun[], now: number): Map<string, WorkspaceBadges> {
  const history = runs.map(slowView);
  const chosen = new Map<string, BadgeRun>();
  const attention = new Map<string, AttentionBadge>();
  for (const [i, run] of runs.entries()) {
    if (!isActive(run) && now - ended(run) > RECENT_MS) continue;
    const current = chosen.get(run.workspaceId);
    if (!current || better(run, current)) chosen.set(run.workspaceId, run);
    if (!isActive(run)) continue;
    const slow = Object.keys(slowSteps(history[i]!, history, now)).length > 0;
    const need = attentionOf(run, slow);
    const known = attention.get(run.workspaceId);
    if (need && (!known || URGENCY[need.kind] < URGENCY[known.kind])) attention.set(run.workspaceId, need);
  }
  const index = new Map<string, WorkspaceBadges>();
  for (const [workspaceId, run] of chosen) {
    const need = attention.get(workspaceId) ?? null;
    const rowTone = need?.kind === "gate" ? "waiting" : STATE_ROW_TONES[stateOf(run)];
    index.set(workspaceId, { rowTone, run: runBadge(run), state: stateBadge(run), attention: need });
  }
  return index;
}
