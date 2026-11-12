import type { AdmissionStatus } from "../shared/types";
import { formatSeconds } from "./script-output";

/** How often the station view asks for the admission checks' status while a station has waiting jobs. */
export const ADMISSION_POLL_MS = 3000;

/** A waiting job's entry at a station, as the pipeline summary has it. */
export interface WaitEntry {
  station: string;
  since: string;
  held: { reason: string; checkedAt: string | null } | null;
  forced: boolean;
}

export interface HeldView {
  /** The badge: "Held", or "Not checked yet" before the first check. */
  badge: string;
  reason: string;
  /** "waiting 12 min · checked 3 min ago". */
  detail: string;
}

/** "3 min ago", "just now": time since an ISO timestamp, as people say it. */
export function agoText(iso: string, now: number): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  return seconds < 5 ? "just now" : `${formatSeconds(seconds)} ago`;
}

/** What the station shows for a waiting job: null when it may board (or was admitted by a human). */
export function heldView(entry: WaitEntry, now: number): HeldView | null {
  if (!entry.held) return null;
  const waiting = `waiting ${formatSeconds((now - Date.parse(entry.since)) / 1000)}`;
  if (entry.held.checkedAt === null) return { badge: "Not checked yet", reason: entry.held.reason, detail: waiting };
  return { badge: "Held", reason: entry.held.reason, detail: `${waiting} · checked ${agoText(entry.held.checkedAt, now)}` };
}

export interface AdmissionLine {
  kind: "checking" | "waiting" | "idle" | "failed";
  /** "Admission: checking · 12 s", "Admission: waiting, next check in ~30 s", "Admission: no jobs waiting". */
  text: string;
  /** A failed check's message and the end of its output, for the alert. */
  error: { message: string; tail: string; when: string } | null;
}

/** The station's admission line. `waiting`: jobs the check looks at now; with none, nothing runs. */
export function admissionLine(status: AdmissionStatus | undefined, waiting: number, now: number): AdmissionLine {
  const failed = status?.error ? { message: status.error.message, tail: status.error.tail, when: agoText(status.error.at, now) } : null;
  if (status?.running && status.since) {
    return { kind: "checking", text: `Admission: checking · ${formatSeconds((now - Date.parse(status.since)) / 1000)}`, error: failed };
  }
  if (waiting === 0) return { kind: "idle", text: "Admission: no jobs waiting", error: failed };
  if (status?.nextCheckAt) {
    const seconds = (Date.parse(status.nextCheckAt) - now) / 1000;
    return { kind: failed ? "failed" : "waiting", text: seconds > 1 ? `Admission: waiting, next check in ~${formatSeconds(seconds)}` : "Admission: next check starting", error: failed };
  }
  return { kind: failed ? "failed" : "waiting", text: "Admission: waiting for the next check", error: failed };
}

/** The alert's heading: "Last check failed 2 min ago (3 checks)". */
export function failureHeading(status: AdmissionStatus, error: NonNullable<AdmissionLine["error"]>): string {
  return `Last check failed ${error.when} (${status.checks} ${status.checks === 1 ? "check" : "checks"})`;
}
