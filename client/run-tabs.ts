import { isActive, isPaused, isTerminal, type Run } from "../shared/types";

/** How a run reads at a glance, most urgent first: its dot group and its tab order. */
export type RunTone = "waiting" | "running" | "paused" | "failed" | "done" | "seen";

export const RUN_TONES: readonly RunTone[] = ["waiting", "running", "paused", "failed", "done", "seen"];

/** Finished runs not opened yet go to History on their own this long after they ended. */
export const SHELVE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Most run tabs shown in a card; the rest go in its History menu. */
export const MAX_TABS = 6;

/** Opened from the panel (this tab's state) or from the Playbooks screen (`seenAt`). */
export function isRead(run: Run, readRuns: readonly string[]): boolean {
  return run.seenAt !== null || readRuns.includes(run.id);
}

export function runTone(run: Pick<Run, "status" | "pausedAt" | "rateHold"> & { after: Record<string, { status: string }> }, read: boolean): RunTone {
  if (isTerminal(run.status)) {
    if (run.status !== "completed") return "failed";
    return read ? "seen" : "done";
  }
  // Paused by hand, or held by rate limiting ("on hold"): the fixed paused violet, never the running blue.
  if (isPaused(run)) return "paused";
  if (run.status === "waiting_gate" || run.status === "boarding") return "waiting";
  return run.rateHold ? "paused" : "running";
}

/** A finished run with nothing left to do here: opened already, or ended over a day ago. */
export function isShelved(run: Run, read: boolean, now: number): boolean {
  if (isActive(run)) return false;
  return read || now - Date.parse(run.updatedAt) > SHELVE_AFTER_MS;
}

/** Most urgent first, then newest first. */
function byUrgency(readRuns: readonly string[]) {
  const rank = (run: Run) => RUN_TONES.indexOf(runTone(run, isRead(run, readRuns)));
  return (a: Run, b: Run) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
}

/**
 * A card's run tabs: runs that are active or not looked at yet, most urgent first, up to
 * MAX_TABS. The selected run always keeps its tab. The others go in the History menu: the
 * overflow first, then shelved runs, newest first.
 */
export function splitTabs(runs: readonly Run[], readRuns: readonly string[], selectedId: string | null, now: number): { tabs: Run[]; more: Run[] } {
  const shelved = (run: Run) => isShelved(run, isRead(run, readRuns), now);
  const open = runs.filter((run) => !shelved(run)).sort(byUrgency(readRuns));
  const history = runs.filter(shelved).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tabs = open.slice(0, MAX_TABS);
  const more = [...open.slice(MAX_TABS), ...history];
  const selected = more.find((run) => run.id === selectedId);
  return selected ? { tabs: [...tabs, selected], more: more.filter((run) => run !== selected) } : { tabs, more };
}

export interface DotGroup {
  tone: RunTone;
  runs: Run[];
  /** A run of the group still moves (not paused): the dot pulses. */
  pulsing: boolean;
}

/** One dot per tone that has runs, most urgent first; each group's runs most urgent, then newest, first. */
export function dotGroups(runs: readonly Run[], readRuns: readonly string[]): DotGroup[] {
  const sorted = [...runs].sort(byUrgency(readRuns));
  return RUN_TONES.map((tone) => {
    const members = sorted.filter((run) => runTone(run, isRead(run, readRuns)) === tone);
    return { tone, runs: members, pulsing: tone !== "paused" && members.some((run) => isActive(run) && !isPaused(run)) };
  }).filter((group) => group.runs.length > 0);
}
