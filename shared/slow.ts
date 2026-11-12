import type { Run, RunStep, RunSummary } from "./types";

/** Slow-step warning (ADR 2026-11-12-slow-step-warning): `runs` latest completed runs make the baseline, `factor` times it is slow. */
export interface SlowWarning {
  runs: number;
  factor: number;
}
export const DEFAULT_SLOW_WARNING: SlowWarning = { runs: 10, factor: 2 };

/** Fewer completed samples than this and a step has no baseline, so it never warns. */
export const MIN_SLOW_SAMPLES = 3;

/** What the warning needs of a step: its status and when it started and ended (null = not yet). */
export interface SlowStepView {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** What the warning needs of a run: a full run or a summary reduces to this. */
export interface SlowRunView {
  id: string;
  playbook: { id: string; slowWarning: SlowWarning };
  steps: Record<string, SlowStepView>;
}

/** A step that runs (or ran) longer than the usual. */
export interface SlowInfo {
  elapsedMs: number;
  baselineMs: number;
  /** elapsed / baseline. */
  ratio: number;
}

/** When a step's work began (its first attempt) and ended (the last attempt, once the step is over). */
export function stepTiming(step: RunStep): { startedAt: string | null; endedAt: string | null } {
  const first = step.attempts[0];
  const last = step.attempts.at(-1);
  const over = step.status === "completed" || step.status === "failed";
  return { startedAt: first?.startedAt ?? null, endedAt: over ? (last?.endedAt ?? null) : null };
}

/** A run or a run summary as the warning reads it. */
export function slowView(run: Run | RunSummary): SlowRunView {
  const steps: Record<string, SlowStepView> = {};
  for (const [id, step] of Object.entries(run.steps)) {
    steps[id] = "attempts" in step ? { status: step.status, ...stepTiming(step) } : { status: step.status, startedAt: step.startedAt, endedAt: step.endedAt };
  }
  return { id: run.id, playbook: { id: run.playbook.id, slowWarning: run.playbook.slowWarning }, steps };
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** How long a step took or has taken so far; null when it has not started. */
export function elapsedMs(step: SlowStepView, now: number): number | null {
  const start = ms(step.startedAt);
  if (start === null || step.status === "pending" || step.status === "ready" || step.status === "skipped") return null;
  const end = ms(step.endedAt) ?? now;
  return Math.max(0, end - start);
}

/**
 * The mean duration of the latest `runs` completed runs of a step (same playbook and step id), the run
 * itself left out; null with fewer than MIN_SLOW_SAMPLES.
 */
export function baselineMs(history: readonly SlowRunView[], playbook: string, stepId: string, runs: number, except: string): number | null {
  const samples: Array<{ end: number; duration: number }> = [];
  for (const run of history) {
    if (run.id === except || run.playbook.id !== playbook) continue;
    const step = run.steps[stepId];
    if (!step || step.status !== "completed") continue;
    const end = ms(step.endedAt);
    const duration = elapsedMs(step, 0);
    if (end === null || duration === null) continue;
    samples.push({ end, duration });
  }
  const latest = samples.sort((a, b) => b.end - a.end).slice(0, runs);
  if (latest.length < MIN_SLOW_SAMPLES) return null;
  return latest.reduce((sum, sample) => sum + sample.duration, 0) / latest.length;
}

/** The slow steps of a run, by step id: elapsed time over `factor` times the baseline. */
export function slowSteps(run: SlowRunView, history: readonly SlowRunView[], now: number): Record<string, SlowInfo> {
  const { runs, factor } = run.playbook.slowWarning;
  const slow: Record<string, SlowInfo> = {};
  for (const [stepId, step] of Object.entries(run.steps)) {
    const elapsed = elapsedMs(step, now);
    if (elapsed === null) continue;
    const baseline = baselineMs(history, run.playbook.id, stepId, runs, run.id);
    if (baseline === null || baseline <= 0 || elapsed <= factor * baseline) continue;
    slow[stepId] = { elapsedMs: elapsed, baselineMs: baseline, ratio: elapsed / baseline };
  }
  return slow;
}

/** A warning that was shown stays: the new reading replaces an old one, but a step missing from it is kept. */
export function keepSlow(shown: Record<string, SlowInfo>, current: Record<string, SlowInfo>): Record<string, SlowInfo> {
  return { ...shown, ...current };
}

/** `45s`, `12m`, `1h05m`. */
export function formatSlowDuration(value: number): string {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `12m, 3.1x the usual 4m`. */
export function slowDetail(info: SlowInfo): string {
  return `${formatSlowDuration(info.elapsedMs)}, ${info.ratio.toFixed(1)}x the usual ${formatSlowDuration(info.baselineMs)}`;
}
