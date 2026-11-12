import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RunSchema, type Job, type Playbook, type Run } from "../shared/types";
import { DEFAULT_EVENT_CORE, readEventCoreConfig } from "./config";
import * as engine from "./engine";
import { loadPlaybooks } from "./loader";
import { checkParity, record, takeEvents, verifyLog } from "./event-core";
import { EventLog } from "./event-log";
import { jobsArea, publicJobEvents } from "./job-events";
import { EVENT_AREAS, RunStore } from "./store";

const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "event-core-"));
  temps.push(dir);
  return dir;
}

const T0 = "2026-11-12T10:00:00.000Z";
const at = (n: number) => `2026-11-12T10:00:${String(n).padStart(2, "0")}.000Z`;

const APPLY = `
title: Apply
singleton: { branch: main }
inputs:
  pr_url: { type: string }
outputs:
  report: { type: string }
outcomes: [done, rejected]
steps:
  - id: dev
    gate: { question: Applied on dev? }
    queue: { mode: merge }
    retries: 1
  - id: prd
    needs: [dev]
    gate: { question: Applied on prd? }
`;
let apply: Playbook;
beforeAll(async () => {
  const dir = await tempDir();
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "apply.yaml"), APPLY);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "apply");
  if (!entry?.playbook) throw new Error(`apply playbook: ${entry?.errors.join("; ")}`);
  apply = entry.playbook;
});

/** A pipeline of two stations: dev (merge, one retry), then prd. */
function pipelineRun(): Run {
  return engine.newPipelineRun({ id: "pipe", playbook: apply, workspaceId: "ws", workspaceDir: "/w", projectId: "p", branch: "main", now: T0 });
}

function newJob(id: string, services?: string): Job {
  return { id, fromRunId: "r1", fromStepId: "apply", attempt: 1, label: "PR", inputs: services ? { services } : {}, status: "open", outcome: null, summary: null, outputs: {}, createdAt: T0, endedAt: null, passed: [], waiting: [], riding: [], failedRides: {}, detached: false };
}

/** Runs a mutator on a copy of the pipeline and checks the reducers rebuild what it did. */
function step(run: Run, fn: (copy: Run) => void): Run {
  const copy = structuredClone(run);
  fn(copy);
  const events = takeEvents(copy);
  expect(events.length).toBeGreaterThan(0);
  expect(checkParity(EVENT_AREAS, run, copy, events)).toEqual([]);
  return copy;
}

describe("job reducers: parity with the engine's mutators", () => {
  it("covers a job through both stations, with a retry, mid-ride outputs, a settle, a failure and a withdrawal", () => {
    let pipe = pipelineRun();
    pipe = step(pipe, (copy) => engine.addJob(copy, newJob("j1"), at(1)));
    pipe = step(pipe, (copy) => engine.addJob(copy, newJob("j2"), at(2)));
    expect(pipe.jobs[0]!.waiting).toEqual([{ station: "dev", since: at(1) }]);
    pipe = step(pipe, (copy) => engine.boardTrain(copy, "dev", "t1", ["j1", "j2"], at(3)));
    const train = engine.newTrainRun({ id: "t1", pipeline: pipe, station: "dev", jobs: pipe.jobs, managerAgentId: "m", now: at(3) });
    // A manager sets outputs, then the train fails once: back to waiting; rides again.
    pipe = step(pipe, (copy) => engine.settleJob(copy, "t1", "j1", { summary: "", outputs: { report: "dev ok" }, now: at(4) }));
    const failed = { ...structuredClone(train), status: "failed" as const, failure: "boom" };
    pipe = step(pipe, (copy) => void engine.trainEnded(copy, failed, at(5)));
    expect(pipe.jobs[0]).toMatchObject({ waiting: [{ station: "dev", since: at(1) }], riding: [], failedRides: { dev: 1 }, outputs: { report: "dev ok" } });
    pipe = step(pipe, (copy) => engine.boardTrain(copy, "dev", "t2", ["j1", "j2"], at(6)));
    // j2 is settled early by the manager (its ride lingers until the train ends); the train completes: j1 advances to prd, j2's ride is released.
    pipe = step(pipe, (copy) => engine.settleJob(copy, "t2", "j2", { outcome: "rejected", summary: "no", outputs: {}, now: at(7) }));
    const done = { ...structuredClone(train), id: "t2", status: "completed" as const, jobs: pipe.jobs.map((job) => structuredClone(job)) };
    pipe = step(pipe, (copy) => void engine.trainEnded(copy, done, at(8)));
    expect(pipe.jobs[0]).toMatchObject({ passed: ["dev"], waiting: [{ station: "prd", since: at(8) }], riding: [] });
    expect(pipe.jobs[1]).toMatchObject({ status: "settled", riding: [] });
    // prd has no retries: a failed train fails the job; the pipeline failing fails the rest; a withdrawal.
    pipe = step(pipe, (copy) => engine.boardTrain(copy, "prd", "t3", ["j1"], at(9)));
    const prd = { ...structuredClone(train), id: "t3", status: "failed" as const, failure: "x", train: { pipelineId: "pipe", playbook: "apply", station: "prd" } };
    pipe = step(pipe, (copy) => void engine.trainEnded(copy, prd, at(10)));
    expect(pipe.jobs[0]).toMatchObject({ status: "failed" });
    pipe = step(pipe, (copy) => engine.addJob(copy, newJob("j3"), at(11)));
    pipe = step(pipe, (copy) => void engine.withdrawJob(copy, "j3", "run canceled", at(12)));
    pipe = step(pipe, (copy) => engine.addJob(copy, newJob("j4"), at(13)));
    pipe = step(pipe, (copy) => void engine.failOpenJobs(copy, "pipeline failed", at(14)));
    expect(pipe.jobs.map((job) => job.status)).toEqual(["failed", "settled", "withdrawn", "failed"]);
  });

  it("reports a mismatch when a reducer and its mutator disagree", () => {
    const pipe = pipelineRun();
    const copy = structuredClone(pipe);
    engine.addJob(copy, newJob("j1"), at(1));
    const events = takeEvents(copy);
    copy.jobs[0]!.passed.push("dev"); // a change no event describes
    expect(checkParity(EVENT_AREAS, pipe, copy, events)).toEqual([expect.stringContaining("jobs[0].passed")]);
    expect(checkParity(EVENT_AREAS, pipe, copy, [{ type: "job.unknown", at: T0, data: {} }])).toEqual([expect.stringContaining("no reducer")]);
  });

  it("assigns results, not deltas, so a replayed event leaves what it set in place", () => {
    const pipe = pipelineRun();
    const copy = structuredClone(pipe);
    engine.addJob(copy, newJob("j1"), at(1));
    engine.boardTrain(copy, "dev", "t1", ["j1"], at(2));
    engine.settleJob(copy, "t1", "j1", { summary: "", outputs: { report: "x" }, now: at(3) });
    const events = takeEvents(copy);
    const once = structuredClone(pipe);
    const twice = structuredClone(pipe);
    for (const event of events) jobsArea.reducers[event.type]!(once, event);
    for (const event of events.slice(2)) jobsArea.reducers[event.type]!(twice, event);
    // `queued` is not idempotent by design (it adds a job): the log's seq, not the reducer, makes a replay safe. What is assigned stays assigned.
    expect(once.jobs[0]!.outputs).toEqual({ report: "x" });
  });

  it("drops events recorded on a copy that is thrown away", () => {
    const pipe = pipelineRun();
    const copy = structuredClone(pipe);
    engine.addJob(copy, newJob("j1"), at(1));
    expect(takeEvents(structuredClone(pipe))).toEqual([]);
    record(pipe, "job.queued", { job: newJob("jx") }, T0);
    expect(takeEvents(pipe)).toHaveLength(1);
    expect(takeEvents(pipe)).toEqual([]);
  });

  it("makes no bus events for a train, and one job.queued per station a job waits at", () => {
    const pipe = pipelineRun();
    const copy = structuredClone(pipe);
    engine.addJob(copy, newJob("j1"), at(1));
    const events = takeEvents(copy);
    expect(publicJobEvents(copy, events).map((event) => [event.type, event.payload.station, event.payload.via])).toEqual([["job.queued", "dev", "handoff"]]);
    expect(publicJobEvents({ ...copy, train: { pipelineId: "p", playbook: "x", station: "dev" } }, events)).toEqual([]);
  });
});

describe("event log store", () => {
  const ev = (type: string, n: number) => ({ type, at: at(n), data: { n } });

  it("appends consecutive seqs per stream, one JSON line each", async () => {
    const log = new EventLog(await tempDir());
    expect((await log.append("a", [ev("job.queued", 1), ev("job.boarded", 2)])).map((event) => event.seq)).toEqual([1, 2]);
    expect((await log.append("a", [ev("job.settled", 3)])).map((event) => event.seq)).toEqual([3]);
    expect((await log.append("b", [ev("job.queued", 1)])).map((event) => event.seq)).toEqual([1]);
    const text = await readFile(log.file("a"), "utf8");
    expect(text.split("\n")).toHaveLength(4);
    expect(JSON.parse(text.split("\n")[0]!)).toMatchObject({ v: 1, stream: "a", seq: 1, type: "job.queued" });
    // A new process: the head comes from the file.
    expect((await new EventLog(log.dir).append("a", [ev("x.y", 4)]))[0]!.seq).toBe(4);
  });

  it("survives a torn last line: dropped on read, cut off before the next append", async () => {
    const dir = await tempDir();
    const log = new EventLog(dir);
    await log.append("a", [ev("job.queued", 1), ev("job.boarded", 2)]);
    await appendFile(log.file("a"), '{"v":1,"stream":"a","seq":3,"type":"job.sett', "utf8");
    const read = await new EventLog(dir).read("a");
    expect(read).toMatchObject({ torn: true, skipped: 0 });
    expect(read.events.map((event) => event.seq)).toEqual([1, 2]);
    const fresh = new EventLog(dir);
    expect((await fresh.append("a", [ev("job.settled", 3)]))[0]!.seq).toBe(3);
    const after = await fresh.read("a");
    expect(after).toMatchObject({ torn: false, skipped: 0 });
    expect(after.events.map((event) => event.type)).toEqual(["job.queued", "job.boarded", "job.settled"]);
  });

  it("skips a damaged or newer-version line in the middle and counts it", async () => {
    const dir = await tempDir();
    const log = new EventLog(dir);
    await log.append("a", [ev("job.queued", 1)]);
    await appendFile(log.file("a"), `not json\n${JSON.stringify({ v: 2, stream: "a", seq: 2, type: "job.future", at: T0, data: {} })}\n`, "utf8");
    await log.append("a", [ev("job.boarded", 2)]);
    const read = await new EventLog(dir).read("a");
    expect(read.skipped).toBe(2);
    expect(read.events.map((event) => event.type)).toEqual(["job.queued", "job.boarded"]);
  });

  it("compacts to genesis events, keeping the seq going", async () => {
    const log = new EventLog(await tempDir());
    await log.append("a", [ev("job.queued", 1), ev("job.boarded", 2)]);
    await log.compact("a", [{ area: "jobs", at: at(3), state: [{ id: "j1" }] }]);
    const { events } = await log.read("a");
    expect(events.map((event) => [event.type, event.seq])).toEqual([["jobs.genesis", 3]]);
    expect((await log.append("a", [ev("job.settled", 4)]))[0]!.seq).toBe(4);
    expect([...(await log.head("a")).genesis]).toEqual(["jobs"]);
  });
});

describe("the run store and its log", () => {
  async function pipelineStore(options: ConstructorParameters<typeof RunStore>[1] = {}) {
    const dir = await tempDir();
    const store = new RunStore(path.join(dir, "runs"), options);
    await store.init();
    await store.create(pipelineRun());
    return { dir, store };
  }
  const add = (store: RunStore, id: string, n: number) => store.mutate("pipe", (run) => engine.addJob(run, newJob(id), at(n)));

  it("starts the log with a genesis event at the first job event and keeps eventSeq on the snapshot", async () => {
    const { store } = await pipelineStore();
    await add(store, "j1", 1);
    await add(store, "j2", 2);
    const { events } = await store.log.read("pipe");
    expect(events.map((event) => [event.seq, event.type])).toEqual([[1, "jobs.genesis"], [2, "job.queued"], [3, "job.queued"]]);
    expect(store.get("pipe")!.eventSeq).toBe(3);
    expect(verifyLog(EVENT_AREAS, store.get("pipe")!, events)).toEqual([]);
  });

  it("loads a run file from before the event core unchanged, and baselines it at its first job event", async () => {
    const { dir, store } = await pipelineStore();
    await add(store, "j1", 1);
    await store.close();
    // The file as an older version wrote it: no eventSeq, no log.
    const file = path.join(dir, "runs", "pipe.json");
    const old = JSON.parse(await readFile(file, "utf8"));
    delete old.eventSeq;
    await writeFile(file, JSON.stringify(old));
    await rm(path.join(dir, "runs", "pipe.events.jsonl"));
    const reopened = new RunStore(path.join(dir, "runs"));
    await reopened.init();
    expect(reopened.get("pipe")!.eventSeq).toBe(0);
    expect(reopened.get("pipe")!.jobs).toHaveLength(1);
    await reopened.mutate("pipe", (run) => engine.addJob(run, newJob("j2"), at(2)));
    const { events } = await reopened.log.read("pipe");
    expect(events[0]).toMatchObject({ type: "jobs.genesis", data: { state: [expect.objectContaining({ id: "j1" })] } });
    expect(verifyLog(EVENT_AREAS, reopened.get("pipe")!, events)).toEqual([]);
  });

  it("restarts cleanly: the log continues, parity holds, nothing is replayed twice", async () => {
    const { dir, store } = await pipelineStore();
    await add(store, "j1", 1);
    await store.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const again = new RunStore(path.join(dir, "runs"));
    await again.init();
    await again.mutate("pipe", (run) => engine.boardTrain(run, "dev", "t1", ["j1"], at(2)));
    expect(warn).not.toHaveBeenCalled();
    const { events } = await again.log.read("pipe");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(again.get("pipe")!.jobs[0]!.riding).toHaveLength(1);
  });

  it("re-baselines after a crash between the log append and the snapshot write", async () => {
    const { dir, store } = await pipelineStore();
    await add(store, "j1", 1);
    await store.close();
    // The log got an event the snapshot never did.
    await appendFile(path.join(dir, "runs", "pipe.events.jsonl"), `${JSON.stringify({ v: 1, stream: "pipe", seq: 3, type: "job.queued", at: at(2), data: { job: newJob("ghost") } })}\n`);
    const again = new RunStore(path.join(dir, "runs"));
    await again.init();
    await again.mutate("pipe", (run) => engine.addJob(run, newJob("j2"), at(3)));
    const { events } = await again.log.read("pipe");
    expect(events.filter((event) => event.type === "jobs.genesis").map((event) => event.seq)).toEqual([1, 4]);
    expect(events.at(-1)!.seq).toBe(5);
    expect(verifyLog(EVENT_AREAS, again.get("pipe")!, events)).toEqual([]);
    expect(again.get("pipe")!.jobs.map((job) => job.id)).toEqual(["j1", "j2"]);
  });

  it("keeps working, with no log, when the flag is off", async () => {
    const { dir, store } = await pipelineStore({ eventCore: { log: false } });
    const heard: string[] = [];
    store.onEvents((_run, events) => heard.push(...events.map((event) => event.type)));
    await add(store, "j1", 1);
    expect(store.get("pipe")!.jobs).toHaveLength(1);
    expect(store.get("pipe")!.eventSeq).toBe(0);
    await expect(stat(path.join(dir, "runs", "pipe.events.jsonl"))).rejects.toThrow();
    expect(heard).toEqual(["job.queued"]);
  });

  it("warns on a parity mismatch in warn mode and fails the mutation in throw mode, never touching state otherwise", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tamper = (store: RunStore) => store.mutate("pipe", (run) => {
      engine.addJob(run, newJob("j1"), at(1));
      run.jobs[0]!.passed.push("dev");
    });
    const warned = await pipelineStore({ eventCore: { parity: "warn" } });
    await tamper(warned.store);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parity mismatch"));
    expect(warned.store.get("pipe")!.jobs).toHaveLength(1);
    const strict = await pipelineStore({ eventCore: { parity: "throw" } });
    await expect(tamper(strict.store)).rejects.toThrow(/parity mismatch/);
    expect(strict.store.get("pipe")!.jobs).toHaveLength(0);
  });

  it("does not fail a mutation when the log cannot be written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store } = await pipelineStore();
    vi.spyOn(store.log, "append").mockRejectedValue(new Error("disk full"));
    await add(store, "j1", 1);
    expect(store.get("pipe")!.jobs).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("event log"), "disk full");
  });

  it("compacts a stream past its size limit and stays replayable", async () => {
    const { store } = await pipelineStore({ compactBytes: 2000 });
    for (let i = 1; i <= 12; i += 1) await add(store, `j${i}`, i);
    const run = store.get("pipe")!;
    const { events } = await store.log.read("pipe");
    expect(events.length).toBeLessThan(12);
    expect(events[0]!.type).toBe("jobs.genesis");
    expect(events.at(-1)!.seq).toBe(run.eventSeq);
    expect(verifyLog(EVENT_AREAS, run, events)).toEqual([]);
  });

  it("deletes the log with the run", async () => {
    const { dir, store } = await pipelineStore();
    await add(store, "j1", 1);
    await store.delete("pipe");
    await expect(stat(path.join(dir, "runs", "pipe.events.jsonl"))).rejects.toThrow();
  });

  it("round-trips through the run schema with eventSeq defaulting to 0", () => {
    const { eventSeq, ...rest } = pipelineRun();
    expect(eventSeq).toBe(0);
    expect(RunSchema.parse(rest).eventSeq).toBe(0);
  });
});

describe("event_core config", () => {
  it("defaults to log on, parity warn; reads both keys; ignores what is malformed", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "config.yaml");
    expect(await readEventCoreConfig(file)).toEqual(DEFAULT_EVENT_CORE);
    await writeFile(file, "event_core: { log: false, parity: off }\n");
    expect(await readEventCoreConfig(file)).toEqual({ log: false, parity: "off" });
    await writeFile(file, "event_core: { log: maybe, parity: loud }\n");
    expect(await readEventCoreConfig(file)).toEqual(DEFAULT_EVENT_CORE);
    await writeFile(file, "profiles: {}\n");
    expect(await readEventCoreConfig(file)).toEqual(DEFAULT_EVENT_CORE);
  });
});
