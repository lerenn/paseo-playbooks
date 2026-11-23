import type { RunPriorityView } from "../shared/types";

/** The accepted range of a priority: the playbook's `quota_limit.priority`. */
export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;

/** What the control sends: a priority (null clears the override) and, for a run with children, the sticky flag. */
export interface PriorityRequest {
  runId: string;
  priority: number | null;
  applyToChildren?: boolean;
}

/** Parses what the user typed: a whole number in range, or null for anything else (nothing is sent). */
export function parsePriority(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= PRIORITY_MIN && value <= PRIORITY_MAX ? value : null;
}

/** One step of the stepper, kept inside the range. */
export const stepped = (value: number, delta: number): number => Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, value + delta));

/** Whether the run's priority is a manual one. */
export const isManual = (view: RunPriorityView): boolean => view.override !== null;

/** "Apply" in the menu: sends the typed priority when it is valid and different from the current one; otherwise nothing. */
export function applyRequest(runId: string, view: RunPriorityView, draft: string): PriorityRequest | null {
  const value = parsePriority(draft);
  if (value === null || value === view.priority) return null;
  return { runId, priority: value, ...(view.hasChildren ? { applyToChildren: view.inheritChildren } : {}) };
}

/** Back to the playbook's priority; the children keep what they have unless the flag is on (the server passes the clear down then). */
export function resetRequest(runId: string, view: RunPriorityView): PriorityRequest {
  return { runId, priority: null, ...(view.hasChildren ? { applyToChildren: view.inheritChildren } : {}) };
}

/**
 * The checkbox "Apply to children": checking applies the run's current priority to its children now and for the ones it starts later;
 * unchecking stops that without touching the children (the priority sent is the override as it is, so no override appears).
 */
export function inheritRequest(runId: string, view: RunPriorityView, checked: boolean): PriorityRequest {
  return { runId, priority: checked ? (view.override ?? view.priority) : view.override, applyToChildren: checked };
}
