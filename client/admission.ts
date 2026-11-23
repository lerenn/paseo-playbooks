import type { AdmissionStatus } from "../shared/types";
import { formatSeconds } from "./script-output";
import { englishTr, type Tr } from "./tr";

/** How often the stage view asks for the admission checks' status while a stage has waiting jobs. */
export const ADMISSION_POLL_MS = 3000;

/** A waiting job's entry at a stage, as the pipeline summary has it. */
export interface WaitEntry {
  stage: string;
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
export function agoText(iso: string, now: number, t: Tr = englishTr): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  return seconds < 5 ? t("graph.admission.justNow") : t("graph.admission.ago", { duration: formatSeconds(seconds, t) });
}

/** What the stage shows for a waiting job: null when it may join (or was admitted by a human). */
export function heldView(entry: WaitEntry, now: number, t: Tr = englishTr): HeldView | null {
  if (!entry.held) return null;
  const waiting = t("graph.admission.waitingFor", { duration: formatSeconds((now - Date.parse(entry.since)) / 1000, t) });
  if (entry.held.checkedAt === null) return { badge: t("graph.admission.notChecked"), reason: entry.held.reason, detail: waiting };
  return { badge: t("graph.admission.held"), reason: entry.held.reason, detail: t("graph.admission.checkedAgo", { waiting, ago: agoText(entry.held.checkedAt, now, t) }) };
}

export interface AdmissionLine {
  kind: "checking" | "waiting" | "idle" | "failed";
  /** "Admission: checking · 12 s", "Admission: waiting, next check in ~30 s", "Admission: no jobs waiting". */
  text: string;
  /** A failed check's message and the end of its output, for the alert. */
  error: { message: string; tail: string; when: string } | null;
}

/** The stage's admission line. `waiting`: jobs the check looks at now; with none, nothing runs. */
export function admissionLine(status: AdmissionStatus | undefined, waiting: number, now: number, t: Tr = englishTr): AdmissionLine {
  const failed = status?.error ? { message: status.error.message, tail: status.error.tail, when: agoText(status.error.at, now, t) } : null;
  if (status?.running && status.since) {
    return { kind: "checking", text: t("graph.admission.checking", { duration: formatSeconds((now - Date.parse(status.since)) / 1000, t) }), error: failed };
  }
  if (waiting === 0) return { kind: "idle", text: t("graph.admission.idle"), error: failed };
  if (status?.nextCheckAt) {
    const seconds = (Date.parse(status.nextCheckAt) - now) / 1000;
    return { kind: failed ? "failed" : "waiting", text: seconds > 1 ? t("graph.admission.waitingNext", { duration: formatSeconds(seconds, t) }) : t("graph.admission.starting"), error: failed };
  }
  return { kind: failed ? "failed" : "waiting", text: t("graph.admission.waitingForNext"), error: failed };
}

/** The alert's heading: "Last check failed 2 min ago (3 checks)". */
export function failureHeading(status: AdmissionStatus, error: NonNullable<AdmissionLine["error"]>, t: Tr = englishTr): string {
  return t("graph.admission.failed", { when: error.when, count: status.checks });
}
