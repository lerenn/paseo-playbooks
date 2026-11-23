import type { QuotaRunRef } from "../shared/quota-limitation";
import { semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

/** The accepted range of a priority: the playbook's `quota_limit.priority`. */
export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;

type RunRef = QuotaRunRef;

/** What the control sends: a priority (null clears the override) and, for a run with children, the sticky flag. */
export interface PriorityRequest {
  runId: string;
  priority: number | null;
  applyToChildren?: boolean;
}

/** The priority the run has now; a server that does not send it (an older one) leaves the control hidden. */
export const hasPriority = (run: RunRef): boolean => run.priority !== undefined;

/** Parses what the user typed: a whole number in range, or null for anything else (nothing is sent). */
export function parsePriority(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= PRIORITY_MIN && value <= PRIORITY_MAX ? value : null;
}

/** One step of the stepper, kept inside the range. */
export const stepped = (value: number, delta: number): number => Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, value + delta));

/** A priority edit; a run that passes its priority to its children sends the flag each time (the checkbox's state). */
export function setRequest(run: RunRef, priority: number, applyToChildren: boolean): PriorityRequest {
  return { runId: run.runId, priority, ...(run.hasChildren ? { applyToChildren } : {}) };
}

/** Back to the playbook's priority; the children keep what they have unless the flag is on (the server passes the clear down then). */
export function resetRequest(run: RunRef, applyToChildren: boolean): PriorityRequest {
  return { runId: run.runId, priority: null, ...(run.hasChildren ? { applyToChildren } : {}) };
}

/**
 * The checkbox "Apply to children": checking applies the run's current priority to its children now and for the ones it starts later;
 * unchecking stops that without touching the children (the priority sent is the override as it is, so no override appears).
 */
export function inheritRequest(run: RunRef, checked: boolean): PriorityRequest {
  return { runId: run.runId, priority: checked ? (run.override ?? run.priority ?? 0) : (run.override ?? null), applyToChildren: checked };
}

/**
 * Colours of a run's line in the Reservations list: its "held" or "paused" tag is the paused violet (as the chips and dots of
 * runs on hold); a manual priority is no state, so it takes the theme's accent, never the waiting orange or the violet.
 */
export function priorityLineColors(theme: Theme, manual: boolean): { tag: string; priority: string } {
  return { tag: semanticColor(theme, "paused"), priority: manual ? theme.colors.accent : theme.colors.foregroundMuted };
}
