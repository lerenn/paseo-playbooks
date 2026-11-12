import { z } from "zod";
import type { Job, Run, VarValue } from "../shared/types";
import { note, type Area, type DomainEvent, type Reducer } from "./event-core";
import type { BusEvent, EventTypeDef } from "./bus";

/**
 * The pipeline jobs and stations area (ADR 2026-11-12-event-core-job-events): the domain events the
 * job mutators of engine.ts record, their reducers, and the public `job.*` bus events they become.
 *
 * Event data are results ("outputs after", "failed rides after"), not deltas to merge, so a reducer
 * is a plain assignment and replaying an event twice leaves the same state.
 */

type Ride = { station: string; runId: string; since: string };
type Wait = { station: string; since: string };
type Outputs = Record<string, VarValue>;

function job(run: Run, id: unknown): Job | undefined {
  return run.jobs.find((candidate) => candidate.id === id);
}

function dropRide(target: Job, trainRunId: unknown): void {
  if (typeof trainRunId === "string") target.riding = target.riding.filter((entry) => entry.runId !== trainRunId);
}

const endLine = (data: Record<string, unknown>) => `${String(data.jobId)}${data.outcome ? `: ${String(data.outcome)}` : ""}${data.summary ? ` (${String(data.summary).slice(0, 200)})` : ""}`;

/**
 * `job.settled`, `job.failed` and `job.withdrawn`: the job ends (`endJob` of the engine). `releases` is a train whose ride
 * ends with it, `clearRiding` drops every ride; `station` and `trainRunId` are context for the bus.
 */
const ends = (status: Job["status"]): Reducer => (run, event) => {
  const d = event.data;
  const target = job(run, d.jobId);
  if (!target) return;
  dropRide(target, d.releases);
  if (d.clearRiding) target.riding = [];
  if (d.failedRides) target.failedRides = d.failedRides as Record<string, number>;
  target.status = status;
  target.outcome = (d.outcome as string | null) ?? null;
  target.summary = d.summary ? String(d.summary) : null;
  target.outputs = d.outputs as Outputs;
  target.endedAt = event.at;
  target.waiting = [];
  note(run, event.at, `job_${status}`, null, endLine(d));
};

export const jobReducers: Record<string, Reducer> = {
  /** A hand-off's job joins the pipeline: `{ job }`, the job with the stations it waits at. */
  "job.queued": (run, event) => {
    const d = event.data as { job: Job };
    run.jobs.push(structuredClone(d.job));
    note(run, event.at, "job_queued", null, `${d.job.id} from ${d.job.fromRunId}/${d.job.fromStepId} at ${d.job.waiting.map((entry) => entry.station).join(", ")}`);
  },
  /** A train takes jobs: `{ station, trainRunId, jobIds, since }` (`since`: jobId -> when it started waiting). */
  "job.boarded": (run, event) => {
    const d = event.data as { station: string; trainRunId: string; jobIds: string[]; since: Record<string, string> };
    for (const target of run.jobs.filter((candidate) => d.jobIds.includes(candidate.id))) {
      target.waiting = target.waiting.filter((entry) => entry.station !== d.station);
      target.riding.push({ station: d.station, runId: d.trainRunId, since: d.since[target.id] ?? event.at });
    }
    note(run, event.at, "train_departed", d.station, `${d.trainRunId} with ${d.jobIds.join(", ")}`);
  },
  /** A train completed with the job on it: it passed the station and waits at `queued`. */
  "job.advanced": (run, event) => {
    const d = event.data as { jobId: string; station: string; trainRunId: string; outputs: Outputs; queued: Wait[] };
    const target = job(run, d.jobId);
    if (!target) return;
    dropRide(target, d.trainRunId);
    target.outputs = d.outputs;
    target.passed.push(d.station);
    target.waiting.push(...structuredClone(d.queued));
  },
  /** A train failed and the station's retries allow another ride: the job waits again where it was. */
  "job.requeued": (run, event) => {
    const d = event.data as { jobId: string; station: string; trainRunId: string; trainStatus: string; since: string; rides: number; retries: number; outputs: Outputs; failedRides: Record<string, number> };
    const target = job(run, d.jobId);
    if (!target) return;
    dropRide(target, d.trainRunId);
    target.outputs = d.outputs;
    target.failedRides = d.failedRides;
    target.waiting.push({ station: d.station, since: d.since });
    note(run, event.at, "job_requeued", d.station, `${d.jobId} after train ${d.trainRunId} ${d.trainStatus} (${d.rides}/${d.retries})`);
  },
  "job.settled": ends("settled"),
  "job.failed": ends("failed"),
  "job.withdrawn": ends("withdrawn"),
  /** A manager set outputs on a job that keeps riding. */
  "job.outputs_set": (run, event) => {
    const d = event.data as { jobId: string; outputs: Outputs; keys: string[] };
    const target = job(run, d.jobId);
    if (!target) return;
    target.outputs = d.outputs;
    note(run, event.at, "job_outputs", null, `${d.jobId}: ${d.keys.join(", ") || "none"}`);
  },
  /** A train ended with a job on it that was no longer open (settled mid-ride): its ride is over. */
  "job.released": (run, event) => {
    const target = job(run, event.data.jobId);
    if (target) dropRide(target, event.data.trainRunId);
  },
  /** A train ended (its jobs' own events come first). */
  "train.ended": (run, event) => {
    const d = event.data as { trainRunId: string; station: string; status: string };
    note(run, event.at, "train_ended", d.station, `${d.trainRunId} ${d.status}`);
  },
  /** On a train's copy of a job: what happened to the job in the pipeline. */
  "job.mirrored": (run, event) => {
    const d = event.data as { jobId: string; status: Job["status"]; outcome: string | null; summary: string | null; outputs: Outputs; endedAt: string | null };
    const copy = job(run, d.jobId);
    if (!copy) return;
    copy.status = d.status;
    copy.outcome = d.outcome;
    copy.summary = d.summary;
    copy.outputs = d.outputs;
    copy.endedAt = d.endedAt;
  },
};

export const jobsArea: Area = {
  name: "jobs",
  reducers: jobReducers,
  state: (run) => run.jobs,
  restore: (run, state) => {
    run.jobs = structuredClone(state as Job[]);
  },
  historyTypes: new Set(["job_queued", "job_settled", "job_failed", "job_withdrawn", "job_requeued", "job_outputs", "train_departed", "train_ended"]),
};

// ------------------------------------------------------------------ public events

const jobFields = {
  /** The pipeline run. */
  runId: z.string(),
  playbook: z.string(),
  runName: z.string().nullable(),
  projectId: z.string(),
  workspaceDir: z.string(),
  jobId: z.string(),
  /** The job's label: the handing-off run's playbook title. */
  label: z.string(),
  /** The station the event is about (null when it is not about one: a withdrawn job, a pipeline that failed). */
  station: z.string().nullable(),
  trainRunId: z.string().nullable(),
  outcome: z.string().nullable(),
};

function jobLine(event: BusEvent, what: string): string {
  const p = event.payload as { runId: string; playbook: string; jobId: string; label: string };
  return `- ${event.type}: job ${p.jobId} (${p.label}) ${what} in pipeline ${p.runId} (${p.playbook}). Tools: get_run { runId: "${p.runId}" }.`;
}

const at = (p: { station: unknown }) => (p.station ? ` at "${String(p.station)}"` : "");
const train = (p: { trainRunId: unknown }) => (p.trainRunId ? ` (train ${String(p.trainRunId)})` : "");

export const JOB_TYPES: EventTypeDef[] = [
  {
    type: "job.queued",
    description: "A job waits at a station: it was handed to the pipeline (via handoff) or passed a station that unlocks this one (via advanced). One event per station.",
    payload: z.object({ ...jobFields, via: z.enum(["handoff", "advanced"]) }),
    line: (event) => jobLine(event, `is waiting${at(event.payload as { station: unknown })} (${String(event.payload.via)})`),
  },
  {
    type: "job.boarded",
    description: "A train took a job at a station: it left the waiting list and rides the train run.",
    payload: z.object(jobFields),
    line: (event) => jobLine(event, `boarded the train${train(event.payload as { trainRunId: unknown })}${at(event.payload as { station: unknown })}`),
  },
  {
    type: "job.advanced",
    description: "A train completed with a job on it: the job passed the station (nextStations: where it waits now; empty when it passed the last one, then job.settled follows).",
    payload: z.object({ ...jobFields, nextStations: z.array(z.string()) }),
    line: (event) => jobLine(event, `passed${at(event.payload as { station: unknown })}${train(event.payload as { trainRunId: unknown })}, now waiting at ${(event.payload.nextStations as string[]).join(", ") || "no station"}`),
  },
  {
    type: "job.requeued",
    description: "A train failed with a job on it and the station's retries allow another ride: the job waits again at the station.",
    payload: z.object({ ...jobFields, rides: z.number().int(), retries: z.number().int() }),
    line: (event) => jobLine(event, `goes back to waiting${at(event.payload as { station: unknown })} after a failed train${train(event.payload as { trainRunId: unknown })} (${String(event.payload.rides)}/${String(event.payload.retries)})`),
  },
  {
    type: "job.settled",
    description: "A job left the pipeline with an outcome: the last station passed (the first outcome) or a train manager settled it.",
    payload: z.object({ ...jobFields, summary: z.string().nullable() }),
    line: (event) => jobLine(event, `was settled: ${String(event.payload.outcome)}${event.payload.summary ? ` (${String(event.payload.summary).slice(0, 200)})` : ""}`),
  },
  {
    type: "job.failed",
    description: "A job failed: its train failed past the station's retries or was canceled, the pipeline ended, or its station was removed. reason says which.",
    payload: z.object({ ...jobFields, reason: z.string().nullable() }),
    line: (event) => jobLine(event, `failed${event.payload.reason ? `: ${String(event.payload.reason).slice(0, 200)}` : ""}`),
  },
  {
    type: "job.withdrawn",
    description: "A job was withdrawn: its hand-off was canceled, reset or timed out.",
    payload: z.object({ ...jobFields, reason: z.string().nullable() }),
    line: (event) => jobLine(event, `was withdrawn${event.payload.reason ? `: ${String(event.payload.reason).slice(0, 200)}` : ""}`),
  },
];

export interface PublicJobEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The bus events a committed mutation of a pipeline makes: one or more per job event that is public
 * (see JOB_TYPES), in order. `run` is the pipeline after the mutation. Events of other types and of
 * a run that is not a pipeline make none.
 */
export function publicJobEvents(run: Run, events: readonly DomainEvent[]): PublicJobEvent[] {
  if (run.train) return [];
  const out: PublicJobEvent[] = [];
  for (const event of events) {
    const d = event.data;
    const base = (jobId: string, station: string | null, trainRunId: string | null, outcome: string | null) => ({
      runId: run.id,
      playbook: run.playbook.id,
      runName: run.name ?? null,
      projectId: run.projectId,
      workspaceDir: run.workspaceDir,
      jobId,
      label: job(run, jobId)?.label ?? "",
      station,
      trainRunId,
      outcome,
    });
    switch (event.type) {
      case "job.queued": {
        const queued = d.job as Job;
        for (const wait of queued.waiting) out.push({ type: "job.queued", payload: { ...base(queued.id, wait.station, null, null), via: "handoff" } });
        break;
      }
      case "job.boarded":
        for (const jobId of d.jobIds as string[]) if (job(run, jobId)) out.push({ type: "job.boarded", payload: base(jobId, d.station as string, d.trainRunId as string, null) });
        break;
      case "job.advanced": {
        const queued = d.queued as Wait[];
        out.push({ type: "job.advanced", payload: { ...base(String(d.jobId), d.station as string, d.trainRunId as string, null), nextStations: queued.map((entry) => entry.station) } });
        for (const wait of queued) out.push({ type: "job.queued", payload: { ...base(String(d.jobId), wait.station, null, null), via: "advanced" } });
        break;
      }
      case "job.requeued":
        out.push({ type: "job.requeued", payload: { ...base(String(d.jobId), d.station as string, d.trainRunId as string, null), rides: d.rides, retries: d.retries } });
        break;
      case "job.settled":
        out.push({ type: "job.settled", payload: { ...base(String(d.jobId), (d.station as string | undefined) ?? null, (d.trainRunId as string | undefined) ?? null, (d.outcome as string | null) ?? null), summary: d.summary ? String(d.summary) : null } });
        break;
      case "job.failed":
      case "job.withdrawn":
        out.push({ type: event.type, payload: { ...base(String(d.jobId), (d.station as string | undefined) ?? null, (d.trainRunId as string | undefined) ?? null, null), reason: d.summary ? String(d.summary) : null } });
        break;
    }
  }
  return out;
}
