import type { GateWaitCondition } from "./types";

/**
 * A date a person typed for a deferral: an ISO date-time ("2026-12-01T09:00:00Z"), or a plain "YYYY-MM-DD" / "YYYY-MM-DD HH:mm"
 * read in the local time zone (a bare day means 09:00). Null when it is not a date.
 */
export function parseWhen(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(value);
  if (local) {
    const [, y, m, d, hh, mm] = local;
    const date = new Date(Number(y), Number(m) - 1, Number(d), hh ? Number(hh) : 9, mm ? Number(mm) : 0);
    if (date.getMonth() !== Number(m) - 1) return null;
    return date.toISOString();
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type DeferDraft =
  | { kind: "manual"; note: string; remind: string }
  | { kind: "date"; when: string; remind: string }
  | { kind: "run_ended"; runId: string; remind: string }
  | { kind: "gate_decided"; runId: string; gateId: string; remind: string };

/** The request a form draft makes, or what is wrong with it. The reason is always required. */
export function deferRequest(reason: string, draft: DeferDraft, now = Date.now()): { ok: true; condition: GateWaitCondition; remindAt: string | null } | { ok: false; error: string } {
  if (!reason.trim()) return { ok: false, error: "Say why you are not deciding now." };
  let remindAt: string | null = null;
  if (draft.remind.trim()) {
    remindAt = parseWhen(draft.remind);
    if (!remindAt) return { ok: false, error: 'The reminder is not a date (use e.g. 2026-12-01 or 2026-12-01 14:30).' };
    if (Date.parse(remindAt) <= now) return { ok: false, error: "The reminder date is in the past." };
  }
  switch (draft.kind) {
    case "manual":
      return { ok: true, condition: { kind: "manual", note: draft.note.trim() }, remindAt };
    case "date": {
      const at = parseWhen(draft.when);
      if (!at) return { ok: false, error: "Enter the date (e.g. 2026-12-01 or 2026-12-01 14:30)." };
      if (Date.parse(at) <= now) return { ok: false, error: "That date is in the past." };
      return { ok: true, condition: { kind: "date", at }, remindAt };
    }
    case "run_ended":
      return draft.runId ? { ok: true, condition: { kind: "run_ended", runId: draft.runId }, remindAt } : { ok: false, error: "Pick the run that has to end." };
    case "gate_decided":
      return draft.runId && draft.gateId ? { ok: true, condition: { kind: "gate_decided", runId: draft.runId, gateId: draft.gateId }, remindAt } : { ok: false, error: "Pick the gate that has to be decided." };
  }
}
