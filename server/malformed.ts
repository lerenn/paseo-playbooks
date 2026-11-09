import { parse } from "yaml";

/** What an agent sent to report_step_result. `summary` is optional here so a call that lost it can be named. */
export type RawReport = { outcome: string; summary?: string; outputs: Record<string, unknown> };

const MARKER = /<\/parameter>|<parameter\s+name\s*=/;
const PARAMETER = /<parameter\s+name\s*=\s*"([^"]+)"\s*>/g;

/** Whether a string argument swallowed the markup of the arguments that follow it. */
export function isMalformed(value: string | undefined): boolean {
  return value !== undefined && MARKER.test(value);
}

/**
 * Splits `first</parameter>\n<parameter name="summary">x</parameter>…` into the first value and
 * the named parameters that followed it. Returns null when the markup cannot be read.
 */
function split(value: string): { first: string; rest: Record<string, string> } | null {
  const cut = value.search(MARKER);
  const first = value.slice(0, cut).trim();
  const rest: Record<string, string> = {};
  const tail = value.slice(cut);
  const names = [...tail.matchAll(PARAMETER)];
  for (const [index, match] of names.entries()) {
    const end = index + 1 < names.length ? names[index + 1]!.index! : tail.length;
    const body = tail.slice(match.index! + match[0].length, end).replace(/<\/parameter>\s*$/, "").replace(/<\/parameter>[\s\S]*$/, "");
    rest[match[1]!] = body.trim();
  }
  return { first, rest };
}

/**
 * Detects a call whose outcome (or summary) holds the rest of the call, and tries to rebuild it.
 * `report` is set when the repaired call has a summary and every part could be read; the caller
 * still validates it like any report. `error` names the mistake when it cannot be repaired.
 */
export function repairReport(raw: RawReport, allowedOutcomes: string[]): { report: { outcome: string; summary: string; outputs: Record<string, unknown> } | null; note: string | null; error: string | null } {
  const bad = isMalformed(raw.outcome) || isMalformed(raw.summary);
  if (!bad) return { report: raw.summary === undefined ? null : { ...raw, summary: raw.summary }, note: null, error: raw.summary === undefined ? 'summary is missing: send outcome, summary and outputs as separate arguments' : null };
  const fail = (): { report: null; note: null; error: string } => ({
    report: null,
    note: null,
    error: `Your call was malformed: the ${isMalformed(raw.outcome) ? "outcome" : "summary"} value contains the other parameters (</parameter> or <parameter name=...>). Send outcome, summary and outputs as separate arguments, outcome being exactly one of: ${allowedOutcomes.join(", ")}.`,
  });
  let outcome = raw.outcome;
  let summary = raw.summary;
  let outputs = raw.outputs;
  const found: Record<string, string> = {};
  if (isMalformed(raw.outcome)) {
    const parts = split(raw.outcome);
    if (!parts) return fail();
    outcome = parts.first;
    Object.assign(found, parts.rest);
  }
  if (summary !== undefined && isMalformed(summary)) {
    const parts = split(summary);
    if (!parts) return fail();
    summary = parts.first;
    Object.assign(found, parts.rest);
  }
  if (found.summary !== undefined && (summary === undefined || summary === "")) summary = found.summary;
  if (found.outputs !== undefined && Object.keys(outputs).length === 0) {
    try {
      const parsed = parse(found.outputs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outputs = parsed as Record<string, unknown>;
      else return fail();
    } catch {
      return fail();
    }
  }
  if (summary === undefined || !allowedOutcomes.includes(outcome)) return fail();
  return { report: { outcome, summary, outputs }, note: `repaired a malformed report_step_result call (the outcome value held the other parameters; read as outcome "${outcome}")`, error: null };
}
