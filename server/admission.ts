import type { Job, Run } from "../shared/types";
import { SCRIPT_NOT_YET } from "../shared/types";
import { admissionJobs, type AdmissionResult } from "./engine";

/**
 * The admission check of a station's queue (`queue.admit`, ADR 2026-11-12-queue-admission-impl): what the plugin gives
 * the script and how it reads the answer. Running it (coalescing, timers, the panel's status) is the runtime's.
 */

/** Most jobs one check is given, oldest first; the rest are looked at once these board or leave. */
export const ADMISSION_JOBS_MAX = 100;
/** Most characters of PLAYBOOK_JOBS (an environment variable has an OS limit); at least one job is always sent. */
export const ADMISSION_JOBS_CHARS = 100_000;
/** A string input longer than this is cut in what the script sees (the job keeps it whole). */
export const ADMISSION_INPUT_CHARS = 10_000;
/** A check that runs longer is killed and counts as failed. */
export const ADMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/** What the script sees of a waiting job. */
export interface AdmissionJob {
  id: string;
  label: string;
  /** When it started waiting at this station. */
  since: string;
  /** Its own inputs, all of them (long strings cut). */
  inputs: Record<string, string | number | boolean>;
}

function clip(inputs: Job["inputs"]): AdmissionJob["inputs"] {
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, typeof value === "string" && value.length > ADMISSION_INPUT_CHARS ? `${value.slice(0, ADMISSION_INPUT_CHARS)}…` : value])) as AdmissionJob["inputs"];
}

/** The station's waiting jobs a check is given (PLAYBOOK_JOBS), within the caps, and how many were left for a later check. */
export function admissionInput(pipeline: Run, stationId: string): { jobs: AdmissionJob[]; omitted: number } {
  const waiting = admissionJobs(pipeline, stationId);
  const jobs: AdmissionJob[] = [];
  let chars = 2;
  for (const job of waiting) {
    const item: AdmissionJob = { id: job.id, label: job.label, since: job.waiting.find((entry) => entry.station === stationId)!.since, inputs: clip(job.inputs) };
    const size = JSON.stringify(item).length + 1;
    if (jobs.length > 0 && (jobs.length >= ADMISSION_JOBS_MAX || chars + size > ADMISSION_JOBS_CHARS)) break;
    jobs.push(item);
    chars += size;
  }
  return { jobs, omitted: waiting.length - jobs.length };
}

export type AdmissionOutcome = { kind: "result"; result: AdmissionResult } | { kind: "not_yet" } | { kind: "failed"; message: string };

const FORMAT = 'print as the last line of stdout one JSON object such as {"admit": ["job_a"], "hold": {"job_b": "QA not passed"}, "escalate": {"job_c": "dependency failed"}}';

/**
 * Reads a finished check: exit 75 asks to be run again (nothing changes), another non-zero exit is a failure, and exit 0
 * must end with a JSON object line with `admit` (a list of job ids), `hold` and `escalate` (job id → reason), each optional;
 * the same keys under `outputs` are read too. Anything unreadable fails the check: it changes nothing and shows in the panel.
 */
export function readAdmission(exit: { code: number | null; signal: string | null }, stdout: string, stderr: string): AdmissionOutcome {
  if (exit.code === SCRIPT_NOT_YET) return { kind: "not_yet" };
  const errTail = stderr.trimEnd().split("\n").at(-1)?.trim();
  if (exit.code !== 0) {
    const why = exit.code !== null ? `exit ${exit.code}` : `killed by ${exit.signal ?? "a signal"}`;
    return { kind: "failed", message: `${why}${errTail ? `: ${errTail}` : ""}` };
  }
  const last = stdout.trimEnd().split("\n").at(-1)?.trim() ?? "";
  let parsed: unknown;
  try {
    parsed = last.startsWith("{") ? JSON.parse(last) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "failed", message: `no result line: ${FORMAT}` };
  const top = parsed as Record<string, unknown>;
  const outputs = top.outputs && typeof top.outputs === "object" && !Array.isArray(top.outputs) ? (top.outputs as Record<string, unknown>) : {};
  const pick = (key: string) => (top[key] !== undefined ? top[key] : outputs[key]);
  const admit = pick("admit") ?? [];
  if (!Array.isArray(admit) || admit.some((id) => typeof id !== "string")) return { kind: "failed", message: "admit must be a list of job ids" };
  const reasons = (key: "hold" | "escalate"): Record<string, string> | string => {
    const value = pick(key) ?? {};
    if (typeof value !== "object" || Array.isArray(value) || value === null) return `${key} must map job ids to reasons`;
    return Object.fromEntries(Object.entries(value).map(([id, reason]) => [id, typeof reason === "string" ? reason : JSON.stringify(reason)]));
  };
  const hold = reasons("hold");
  if (typeof hold === "string") return { kind: "failed", message: hold };
  const escalate = reasons("escalate");
  if (typeof escalate === "string") return { kind: "failed", message: escalate };
  return { kind: "result", result: { admit: admit as string[], hold, escalate } };
}
