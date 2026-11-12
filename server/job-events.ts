import { z } from "zod";
import type { Gate, Job, Run, VarValue } from "../shared/types";
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
type Wait = Job["waiting"][number];
type Outputs = Record<string, VarValue>;

/** A waiting entry as an older log wrote it (no admission fields) gets their defaults. */
const upcastWait = (wait: Partial<Wait> & { station: string; since: string }): Wait => ({ held: null, forced: false, ...structuredClone(wait) });
const upcastJob = (value: Job): Job => ({ ...structuredClone(value), waiting: value.waiting.map(upcastWait) });

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
    run.jobs.push(upcastJob(d.job));
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
    target.waiting.push(...d.queued.map(upcastWait));
  },
  /** A train failed and the station's retries allow another ride: the job waits again where it was. */
  "job.requeued": (run, event) => {
    const d = event.data as { jobId: string; station: string; trainRunId: string; trainStatus: string; since: string; rides: number; retries: number; outputs: Outputs; failedRides: Record<string, number> };
    const target = job(run, d.jobId);
    if (!target) return;
    dropRide(target, d.trainRunId);
    target.outputs = d.outputs;
    target.failedRides = d.failedRides;
    target.waiting.push({ station: d.station, since: d.since, held: null, forced: false });
    note(run, event.at, "job_requeued", d.station, `${d.jobId} after train ${d.trainRunId} ${d.trainStatus} (${d.rides}/${d.retries})`);
  },
  /** A station's admission script holds a waiting job: `{ jobId, station, reason, checkedAt }`. */
  "job.held": (run, event) => {
    const d = event.data as { jobId: string; station: string; reason: string; checkedAt: string };
    const entry = job(run, d.jobId)?.waiting.find((wait) => wait.station === d.station);
    if (!entry) return;
    entry.held = { reason: d.reason, checkedAt: d.checkedAt };
    note(run, event.at, "job_held", d.station, `${d.jobId}: ${d.reason.slice(0, 200)}`);
  },
  /** A waiting job may board: `{ jobId, station, via, reason, forced }` (a human's `forced` admission is final). */
  "job.admitted": (run, event) => {
    const d = event.data as { jobId: string; station: string; via: string; reason: string | null; forced: boolean };
    const entry = job(run, d.jobId)?.waiting.find((wait) => wait.station === d.station);
    if (!entry) return;
    entry.held = null;
    if (d.forced) entry.forced = true;
    note(run, event.at, "job_admitted", d.station, `${d.jobId} via ${d.via}${d.reason ? `: ${d.reason.slice(0, 200)}` : ""}`);
  },
  /** The script cannot admit a job by itself: it is held and, unless a gate is already open for it, an admission gate opens: `{ jobId, station, reason, gate }`. */
  "job.escalated": (run, event) => {
    const d = event.data as { jobId: string; station: string; reason: string; gate: Gate };
    run.gates.push(structuredClone(d.gate));
    note(run, event.at, "gate_opened", d.station, d.gate.id);
  },
  /** An admission gate closed: a human decided it, or its job left or was admitted another way: `{ gateId, status, comment, by, via }`. */
  "admission.gate_closed": (run, event) => {
    const d = event.data as { gateId: string; status: string; comment: string | null; by: string | null; via: Gate["decidedVia"] };
    const gate = run.gates.find((candidate) => candidate.id === d.gateId);
    if (!gate) return;
    gate.status = d.status;
    gate.comment = d.comment;
    gate.decidedBy = d.by;
    gate.decidedVia = d.via;
    gate.decidedAt = event.at;
    note(run, event.at, "gate_decided", gate.stepId, `${gate.id}: ${d.status}${d.via ? ` via ${d.via}` : ""}`);
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

/** What the jobs area owns: the jobs, and the admission gates their stations opened (gates of a pipeline run). */
interface JobsState {
  jobs: Job[];
  gates: Gate[];
}

export const jobsArea: Area = {
  name: "jobs",
  reducers: jobReducers,
  state: (run): JobsState => ({ jobs: run.jobs, gates: run.gates.filter((gate) => gate.kind === "admission") }),
  restore: (run, state) => {
    // A genesis written before admission holds the jobs alone.
    const from: Partial<JobsState> = Array.isArray(state) ? { jobs: state as Job[] } : (state as JobsState);
    run.jobs = (from.jobs ?? []).map(upcastJob);
    run.gates = [...run.gates.filter((gate) => gate.kind !== "admission"), ...structuredClone(from.gates ?? [])];
  },
  historyTypes: new Set(["job_queued", "job_settled", "job_failed", "job_withdrawn", "job_requeued", "job_outputs", "job_held", "job_admitted", "train_departed", "train_ended", "gate_opened", "gate_decided"]),
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
    type: "job.held",
    description: "A station's admission script holds a waiting job (queue.admit), or changed the reason it holds it: reason says why. Not sent again while the reason stays the same. The job does not board until job.admitted.",
    payload: z.object({ ...jobFields, reason: z.string() }),
    line: (event) => jobLine(event, `is held${at(event.payload as { station: unknown })}: ${String(event.payload.reason).slice(0, 200)}`),
  },
  {
    type: "job.admitted",
    description: "A held or unchecked job may board the next train of its station: the admission script said so (via script) or a human admitted it anyway (via human; reason is their comment).",
    payload: z.object({ ...jobFields, via: z.enum(["script", "human"]), reason: z.string().nullable() }),
    line: (event) => jobLine(event, `was admitted${at(event.payload as { station: unknown })} (via ${String(event.payload.via)})`),
  },
  {
    type: "job.escalated",
    description: "A station's admission script cannot admit a job by itself: it stays held and a human is asked (gate.opened, kind admission; gateId). Not sent again while that gate is open.",
    payload: z.object({ ...jobFields, reason: z.string(), gateId: z.string() }),
    line: (event) => jobLine(event, `needs a human${at(event.payload as { station: unknown })}: ${String(event.payload.reason).slice(0, 200)} (gate ${String(event.payload.gateId)})`),
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
      case "job.held":
        out.push({ type: "job.held", payload: { ...base(String(d.jobId), d.station as string, null, null), reason: String(d.reason) } });
        break;
      case "job.admitted":
        out.push({ type: "job.admitted", payload: { ...base(String(d.jobId), d.station as string, null, null), via: d.via as string, reason: (d.reason as string | null) ?? null } });
        break;
      case "job.escalated":
        out.push({ type: "job.escalated", payload: { ...base(String(d.jobId), d.station as string, null, null), reason: String(d.reason), gateId: (d.gate as Gate).id } });
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
