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

/**
 * The menu's draft: one number (the source of truth) and the text the field shows. Buttons change the number and the text follows;
 * typing changes the text and the number follows when it parses; leaving the field (or Enter) puts the text back to the number.
 */
export interface PriorityDraft {
  value: number;
  text: string;
}

/** The draft a menu starts from each time it opens (and when the server's figure changes): the run's effective priority. */
export const draftFor = (view: RunPriorityView): PriorityDraft => ({ value: view.priority, text: String(view.priority) });

/** A stepper press: from the number, clamped, and the field shows it. */
export function stepDraft(draft: PriorityDraft, delta: number): PriorityDraft {
  const value = stepped(draft.value, delta);
  return { value, text: String(value) };
}

/** Typing: the text is kept as typed; the number follows only when it is a valid priority (NaN, empty or out of range leave it alone). */
export function typeDraft(draft: PriorityDraft, text: string): PriorityDraft {
  const value = parsePriority(text);
  return { value: value ?? draft.value, text };
}

/** Blur or Enter: an invalid text goes back to the number, a valid one is normalised ("+5 " is not accepted, " 5 " becomes "5"). */
export function commitDraft(draft: PriorityDraft): PriorityDraft {
  const value = parsePriority(draft.text) ?? draft.value;
  return { value, text: String(value) };
}

/** "Apply": sends the draft number when it differs from the effective priority. The typed text must be valid too, so a half-typed field sends nothing. */
export function applyDraft(runId: string, view: RunPriorityView, draft: PriorityDraft): PriorityRequest | null {
  return applyRequest(runId, view, draft.text);
}

/** What the "Run now, ignore burn rate limits" control sends (the runs.set_exempt RPC). */
export interface ExemptRequest {
  runId: string;
  exempt: boolean;
  applyToChildren?: boolean;
}

/** The two taps of the emergency button: the first asks to confirm, the second sends. Going back under the limits needs no confirmation. */
export type ExemptStage = "idle" | "confirm";

/** One press of the exempt button: what to show next and whether to send now. */
export function pressExempt(view: RunPriorityView, stage: ExemptStage): { stage: ExemptStage; send: boolean } {
  if (view.exempt) return { stage: "idle", send: true };
  return stage === "confirm" ? { stage: "idle", send: true } : { stage: "confirm", send: false };
}

/**
 * The request of the exempt button: the opposite of the run's state. `children` is the "Apply to children" checkbox as the user set it
 * in this menu (undefined = never touched: the sticky flag is left as it is), and only a run with children carries it.
 */
export function exemptRequest(runId: string, view: RunPriorityView, children: boolean | undefined): ExemptRequest {
  return { runId, exempt: !view.exempt, ...(view.hasChildren && children !== undefined ? { applyToChildren: children } : {}) };
}

/** Whether the "Apply to children" box shows as checked: the user's choice in this menu, else the flag the run has (the priority's, or the exemption's for an exempt run). */
export const childrenChecked = (view: RunPriorityView, choice: boolean | undefined): boolean => choice ?? (view.exempt ? view.inheritChildExempt : view.inheritChildren);
