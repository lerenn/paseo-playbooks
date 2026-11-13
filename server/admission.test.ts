import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Job, Playbook, Run } from "../shared/types";
import { RunSchema } from "../shared/types";
import { admissionInput, ADMISSION_JOBS_MAX, readAdmission } from "./admission";
import type { BusEvent } from "./bus";
import * as engine from "./engine";
import { checkParity, takeEvents, verifyLog } from "./event-core";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { EVENT_AREAS, RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

const T0 = "2026-11-12T10:00:00.000Z";
const at = (n: number) => `2026-11-12T10:00:${String(n).padStart(2, "0")}.000Z`;

/** A pipeline whose first stage (dev) and last (prd) both have an admission script. */
const APPLY = (admit = "{ script: admit.sh, poll: 1h }", mode = "fifo") => `
title: Apply
singleton: { branch: main }
inputs:
  pr_url: { type: string, required: true }
  ticket: { type: string }
outputs:
  report: { type: string }
outcomes: [done, rejected]
steps:
  - id: dev
    gate: { question: Applied on dev? }
    queue: { mode: ${mode}, admit: ${admit} }
    retries: 1
  - id: prd
    needs: [dev]
    gate: { question: Applied on prd? }
`;

const PR = `
title: PR
inputs:
  pr_url: { type: string, required: true }
  ticket: { type: string }
steps:
  - id: apply
    handoff: { name: apply }
    inputs: { pr_url: ~, ticket: ~ }
`;

/** Logs each check, records what it was given, and answers with verdict.json (`{}` by default); `exit` makes it exit with that code. */
const ADMIT_SH = `#!/bin/sh
echo "$PLAYBOOK_CHECK $PLAYBOOK_STAGE $PLAYBOOK_PIPELINE $PLAYBOOK_RUN_ID $PLAYBOOK_STEP_ID $PWD" >> "$PWD/admit.log"
echo "$PLAYBOOK_JOBS" > "$PWD/jobs-seen.json"
echo "$PLAYBOOK_JOBS_OMITTED" > "$PWD/omitted-seen"
[ -f "$PWD/slow" ] && sleep 0.3
[ -f "$PWD/exit" ] && { echo "boom on stderr" >&2; exit "$(cat "$PWD/exit")"; }
echo "some log line"
[ -f "$PWD/verdict.json" ] && cat "$PWD/verdict.json" || echo '{}'
`;

function fakePaseo(dir: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
    archive: async () => undefined,
  });
  const createAgent = async () => {
    const id = `mgr${++agents}`;
    return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
  };
  const workspace = (id: string) => ({ id, projectId: "p", workspaceDirectory: dir });
  return {
    sent,
    paseo: {
      agents: { ref },
      workspaces: {
        ref: (id: string) => ({ refresh: async () => workspace(id), agents: { create: createAgent }, archive: async () => undefined }),
        create: async () => ({ id: "wt1", agents: { create: createAgent } }),
      },
    },
  };
}

async function writePlaybooks(dir: string, files: Record<string, string>, scripts: Record<string, string> = { "admit.sh": ADMIT_SH }) {
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(root, "scripts", name), body);
    await chmod(path.join(root, "scripts", name), 0o755);
  }
}

async function loaded(files: Record<string, string>, scripts?: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "admission-"));
  temps.push(dir);
  await writePlaybooks(dir, files, scripts);
  return { dir, entries: (await loadPlaybooks(dir)).entries };
}

async function errorsOf(yaml: string, scripts?: Record<string, string>): Promise<string> {
  const { entries } = await loaded({ "apply.yaml": yaml }, scripts);
  return entries.find((entry) => entry.id === "apply")!.errors.join("\n");
}

describe("queue.admit: loading", () => {
  it("reads the block into the stage: script path, poll, wake_on", async () => {
    const { entries } = await loaded({ "apply.yaml": APPLY("{ script: admit.sh, poll: 10m, wake_on: [{ types: [job.settled, job.advanced], filter: { playbook: other, stage: stg } }] }", "merge") });
    const apply = entries.find((entry) => entry.id === "apply")!;
    expect(apply.errors).toEqual([]);
    expect(apply.playbook!.singleton!.stages[0]).toMatchObject({
      id: "dev",
      mode: "merge",
      admit: { script: ".paseo/plugins/playbooks/scripts/admit.sh", pollMs: 600_000, wakeOn: [{ types: ["job.settled", "job.advanced"], filter: { playbook: "other", stage: "stg" } }] },
    });
    expect(apply.playbook!.singleton!.stages[1]!.admit).toBeUndefined();
  });

  it("accepts the staged_release example", async () => {
    const entry = (await loadPlaybooks(EXAMPLES)).entries.find((candidate) => candidate.id === "staged_release")!;
    expect(entry.errors).toEqual([]);
    expect(entry.playbook!.singleton!.stages[1]!.admit).toMatchObject({ pollMs: 600_000, wakeOn: [{ types: ["job.advanced", "job.settled"], filter: { playbook: "qa_pipeline", stage: "smoke" } }] });
  });

  it("accepts the new job events as wake_on types, and their declared fields as filters", async () => {
    const yaml = APPLY("{ script: admit.sh, poll: 10m, wake_on: [{ types: [\"job.*\"], filter: { playbook: other } }, { types: [job.held], filter: { reason: x } }] }");
    expect(await errorsOf(yaml)).toBe("");
  });

  it("refuses admit without poll, without a script, with a missing or unknown script, and with a bad wake_on", async () => {
    expect(await errorsOf(APPLY("{ script: admit.sh }"))).toMatch(/queue\.admit needs `poll`: events are a hint, the poll is the safety net/);
    expect(await errorsOf(APPLY("{ poll: 10m }"))).toMatch(/script/);
    expect(await errorsOf(APPLY("{ script: missing.sh, poll: 10m }"))).toMatch(/queue\.admit\.script: scripts\/missing\.sh not found/);
    expect(await errorsOf(APPLY("{ script: admit.sh, poll: soon }"))).toMatch(/queue\.admit\.poll: expected a duration/);
    expect(await errorsOf(APPLY("{ script: admit.sh, poll: 10m, wake_on: [{ types: [job.exploded] }] }"))).toMatch(/queue\.admit\.wake_on\[0\]/);
    expect(await errorsOf(APPLY("{ script: admit.sh, poll: 10m, wake_on: [{ types: [job.settled], filter: { nope: 1 } }] }"))).toMatch(/wake_on\[0\].*nope/);
    expect(await errorsOf(APPLY("{ script: admit.sh, poll: 10m, wake_on: [{ types: [job.settled], filter: { olderThanMinutes: 5 } }] }"))).toMatch(/olderThanMinutes/);
    expect(await errorsOf(APPLY("{ script: admit.sh, poll: 10m, flag: true }"))).toMatch(/flag/);
  });

  it("refuses admit outside a singleton, and in a flat form", async () => {
    const plain = (await loaded({ "w.yaml": "title: W\nsteps:\n  - id: a\n    gate: { question: ok }\n    queue: { admit: { script: admit.sh, poll: 1m } }\n" })).entries.find((entry) => entry.id === "w")!;
    expect(plain.errors.join("\n")).toMatch(/`queue` only applies to a step of a singleton playbook/);
    expect(await errorsOf(APPLY("{ script: admit.sh, poll: 1m }").replace("    retries: 1", "    retries: 1\n    admit: { script: admit.sh, poll: 1m }"))).toMatch(/`admit` goes under `queue:`/);
  });
});

// ------------------------------------------------------------------ engine

function pipeline(playbook: Playbook): Run {
  return engine.newPipelineRun({ id: "pipe", playbook, workspaceId: "ws", workspaceDir: "/w", projectId: "p", branch: "main", now: T0 });
}

function job(id: string, inputs: Job["inputs"] = {}): Job {
  return { id, fromRunId: "r1", fromStepId: "apply", attempt: 1, label: `PR ${id}`, inputs, status: "open", outcome: null, summary: null, outputs: {}, createdAt: T0, endedAt: null, passed: [], waiting: [], batches: [], failedRides: {}, detached: false, requeued: null, requeues: {}, followUps: [], reopens: [] };
}

/** Runs a mutator on a copy and checks the reducers rebuild what it did (parity), including the admission gates. */
function step<T = void>(run: Run, fn: (copy: Run) => T): { run: Run; value: T } {
  const copy = structuredClone(run);
  const value = fn(copy);
  const events = takeEvents(copy);
  expect(events.length).toBeGreaterThan(0);
  expect(checkParity(EVENT_AREAS, run, copy, events)).toEqual([]);
  return { run: copy, value };
}

const verdict = (over: Partial<engine.AdmissionResult>): engine.AdmissionResult => ({ admit: [], hold: {}, escalate: {}, ...over });
const heldOf = (run: Run, id: string, stage = "dev") => run.jobs.find((candidate) => candidate.id === id)!.waiting.find((entry) => entry.stage === stage)!;
const decision = (choice: string, comment: string | null = null) => ({ decision: choice, comment, by: "Ada", via: "panel" as const, now: at(30) });

describe("queue.admit: the engine", () => {
  async function apply(mode = "fifo"): Promise<Playbook> {
    const { entries } = await loaded({ "apply.yaml": APPLY("{ script: admit.sh, poll: 1h }", mode) });
    return entries.find((entry) => entry.id === "apply")!.playbook!;
  }

  it("holds a requeued job at a stage with admit until the script has looked at it again, and gives the script the reason and blocker", async () => {
    const playbook = structuredClone(await apply("merge"));
    playbook.outcomes = [...playbook.outcomes, "blocked"];
    playbook.singleton!.stages[0]!.effects = { blocked: "requeue" };
    let run = pipeline(playbook);
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    run = step(run, (copy) => engine.admitJob(copy, "j1", "dev", "script", at(2))).run;
    run = step(run, (copy) => engine.joinBatch(copy, "dev", "t1", ["j1"], at(3))).run;
    run = step(run, (copy) => void engine.settleJob(copy, "t1", "j1", { outcome: "blocked", summary: "pin not merged", outputs: {}, blocker: "pin-42", now: at(4) })).run;
    expect(heldOf(run, "j1")).toMatchObject({ since: at(1), held: { reason: "requeued (blocked: pin not merged (blocker: pin-42))", checkedAt: null } });
    expect(engine.nextBatchJobs(run, "dev")).toEqual([]);
    expect(admissionInput(run, "dev").jobs[0]).toMatchObject({ id: "j1", requeued: { outcome: "blocked", reason: "pin not merged", blocker: "pin-42" } });
    run = step(run, (copy) => void engine.applyAdmission(copy, "dev", ["j1"], verdict({ admit: ["j1"] }), at(5))).run;
    expect(engine.nextBatchJobs(run, "dev").map((entry) => entry.id)).toEqual(["j1"]);
  });

  it("holds a job at a stage with admit until its first check; a stage without one is untouched", async () => {
    let run = pipeline(await apply());
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    expect(heldOf(run, "j1")).toMatchObject({ held: { reason: engine.ADMISSION_PENDING, checkedAt: null }, forced: false });
    expect(engine.nextBatchJobs(run, "dev")).toEqual([]);
    // prd has no admit block: a job that reaches it waits unheld.
    run.jobs[0]!.passed.push("dev");
    run.jobs[0]!.waiting = [];
    const at2 = structuredClone(run);
    engine.addJob(at2, job("j2"), at(2));
    const prd = structuredClone(run.jobs[0]!);
    expect(prd.waiting).toEqual([]);
  });

  it("skips held jobs before fifo and merge apply: a held head job does not block the others", async () => {
    for (const mode of ["fifo", "merge"]) {
      let run = pipeline(await apply(mode));
      for (const [index, id] of ["j1", "j2", "j3"].entries()) run = step(run, (copy) => engine.addJob(copy, job(id), at(index + 1))).run;
      run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1", "j2", "j3"], verdict({ admit: ["j2", "j3"], hold: { j1: "QA not passed" } }), at(5))).run;
      expect(heldOf(run, "j1").held).toEqual({ reason: "QA not passed", checkedAt: at(5) });
      expect(heldOf(run, "j2").held).toBeNull();
      // j1 is the oldest, yet fifo takes j2: the held head does not block the queue.
      expect(engine.nextBatchJobs(run, "dev").map((candidate) => candidate.id)).toEqual(mode === "fifo" ? ["j2"] : ["j2", "j3"]);
    }
  });

  it("holds a job the script did not name, with the default reason, and holds again only when the reason changes", async () => {
    let run = pipeline(await apply());
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({}), at(2))).run;
    expect(heldOf(run, "j1").held).toEqual({ reason: engine.NOT_ADMITTED, checkedAt: at(2) });
    // Same reason again: no event, no change (even the check time stays: it is when the reason was decided).
    const copy = structuredClone(run);
    engine.applyAdmission(copy, "dev", ["j1"], verdict({}), at(3));
    expect(takeEvents(copy)).toEqual([]);
    expect(heldOf(copy, "j1").held!.checkedAt).toBe(at(2));
    run = step(run, (current) => engine.applyAdmission(current, "dev", ["j1"], verdict({ hold: { j1: "waiting for QA" } }), at(4))).run;
    expect(heldOf(run, "j1").held!.reason).toBe("waiting for QA");
  });

  it("admits only a held job (no event for one that is already admitted), and a later check may hold it again", async () => {
    let run = pipeline(await apply());
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({ admit: ["j1"] }), at(2))).run;
    expect(heldOf(run, "j1").held).toBeNull();
    const again = structuredClone(run);
    engine.applyAdmission(again, "dev", ["j1"], verdict({ admit: ["j1"] }), at(3));
    expect(takeEvents(again)).toEqual([]);
    run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({ hold: { j1: "CI red again" } }), at(4))).run;
    expect(engine.nextBatchJobs(run, "dev")).toEqual([]);
  });

  it("ignores ids that were not sent (with a warning), and takes the strictest verdict for a job named twice", async () => {
    let run = pipeline(await apply());
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    const { run: next, value } = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({ admit: ["j1", "ghost"], hold: { j1: "no" }, escalate: { other: "x" } }), at(2)));
    expect(value.warnings).toEqual([expect.stringContaining('unknown job id "ghost"'), expect.stringContaining('unknown job id "other"'), expect.stringContaining('"j1" is named in admit and in hold')]);
    expect(heldOf(next, "j1").held!.reason).toBe("no");
  });

  it("opens one human ask per escalated job, and not another while it is open", async () => {
    let run = pipeline(await apply());
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    const first = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({ escalate: { j1: "dependency failed" } }), at(2)));
    run = first.run;
    expect(first.value.escalated).toHaveLength(1);
    expect(run.gates).toEqual([expect.objectContaining({ kind: "admission", jobId: "j1", stepId: "dev", status: "pending", summary: expect.stringContaining("Job j1 (PR j1) cannot be admitted at Dev: dependency failed") })]);
    expect(heldOf(run, "j1").held!.reason).toBe("dependency failed");
    // The same reason, or another one: held again, but no second gate.
    const again = structuredClone(run);
    expect(engine.applyAdmission(again, "dev", ["j1"], verdict({ escalate: { j1: "dependency failed" } }), at(3)).escalated).toEqual([]);
    expect(takeEvents(again)).toEqual([]);
    run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({ escalate: { j1: "held too long" } }), at(4))).run;
    expect(run.gates).toHaveLength(1);
  });

  it("answers an admission gate: retry keeps holding, admit lets it join for good, withdraw ends the job", async () => {
    let base = pipeline(await apply());
    for (const [index, id] of ["j1", "j2"].entries()) base = step(base, (copy) => engine.addJob(copy, job(id), at(index + 1))).run;
    base = step(base, (copy) => engine.applyAdmission(copy, "dev", ["j1", "j2"], verdict({ escalate: { j1: "dep failed", j2: "dep failed" } }), at(3))).run;
    const [g1, g2] = base.gates;
    expect(base.gates).toHaveLength(2);

    const retried = step(base, (copy) => engine.decideGate(copy, g1!.id, decision("retry", "try again"))).run;
    expect(retried.gates[0]).toMatchObject({ status: "retry", comment: "try again", decidedBy: "Ada", decidedVia: "panel" });
    expect(heldOf(retried, "j1").held).not.toBeNull();

    // admit anyway: it joins, and the script no longer holds it nor is it given to the next check.
    const admitted = step(base, (copy) => engine.decideGate(copy, g1!.id, decision("admit", "ok by me"))).run;
    expect(heldOf(admitted, "j1")).toMatchObject({ held: null, forced: true });
    expect(engine.nextBatchJobs(admitted, "dev").map((candidate) => candidate.id)).toEqual(["j1"]);
    expect(engine.admissionJobs(admitted, "dev").map((candidate) => candidate.id)).toEqual(["j2"]);
    const rechecked = step(admitted, (copy) => engine.applyAdmission(copy, "dev", ["j1", "j2"], verdict({}), at(40))).run;
    expect(heldOf(rechecked, "j1").held).toBeNull();

    const withdrawn = step(base, (copy) => engine.decideGate(copy, g2!.id, decision("withdraw", "gone"))).run;
    expect(withdrawn.jobs[1]).toMatchObject({ status: "withdrawn", waiting: [] });
    expect(withdrawn.jobs[1]!.summary).toMatch(/withdrawn from the "Dev" queue by Ada: gone/);

    // Decided once; a manager or role cannot decide it.
    expect(engine.decideGate(structuredClone(retried), g1!.id, decision("admit")).alreadyDecided).toBe(true);
    expect(() => engine.decideGate(structuredClone(base), g1!.id, { ...decision("admit"), via: "manager" })).toThrow(/a human decides it/);
    expect(() => engine.decideGate(structuredClone(base), g1!.id, decision("nope"))).toThrow(/not a choice/);
  });

  it("closes an open ask when the script admits the job, when it is withdrawn by its run, and when its stage is removed", async () => {
    let run = pipeline(await apply());
    for (const [index, id] of ["j1", "j2", "j3"].entries()) run = step(run, (copy) => engine.addJob(copy, job(id), at(index + 1))).run;
    run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1", "j2", "j3"], verdict({ escalate: { j1: "x", j2: "x", j3: "x" } }), at(5))).run;
    const [g1, g2, g3] = run.gates;
    run = step(run, (copy) => engine.applyAdmission(copy, "dev", ["j1"], verdict({ admit: ["j1"] }), at(6))).run;
    expect(run.gates[0]).toMatchObject({ id: g1!.id, status: "dismissed", decidedBy: null });
    // A held job is withdrawn by its parent run like any waiting one, and a removed stage fails it as today.
    run = step(run, (copy) => void engine.withdrawJob(copy, "j2", "run canceled", at(7))).run;
    expect(run.jobs[1]).toMatchObject({ status: "withdrawn" });
    expect(run.gates.find((gate) => gate.id === g2!.id)!.status).toBe("dismissed");
    run = step(run, (copy) => void engine.failJobs(copy, ["j3"], "its stage was removed from the playbook", at(8))).run;
    expect(run.jobs[2]).toMatchObject({ status: "failed", waiting: [] });
    expect(run.gates.find((gate) => gate.id === g3!.id)!.status).toBe("dismissed");
  });

  it("lets held jobs join once the stage no longer has an admit block", async () => {
    let run = pipeline(await apply());
    run = step(run, (copy) => engine.addJob(copy, job("j1"), at(1))).run;
    expect(engine.nextBatchJobs(run, "dev")).toEqual([]);
    run.playbook.singleton!.stages[0] = { ...run.playbook.singleton!.stages[0]!, admit: undefined };
    expect(engine.nextBatchJobs(run, "dev").map((candidate) => candidate.id)).toEqual(["j1"]);
  });

  it("works the same with the event log off: state identical, no log file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "admission-nolog-"));
    temps.push(dir);
    const play = await apply();
    const run = async (log: boolean) => {
      const store = new RunStore(path.join(dir, String(log)), { eventCore: { log, parity: "throw" } });
      await store.init();
      await store.create(pipeline(play));
      await store.mutate("pipe", (r) => engine.addJob(r, job("j1"), at(1)));
      await store.mutate("pipe", (r) => engine.addJob(r, job("j2"), at(2)));
      await store.mutate("pipe", (r) => void engine.applyAdmission(r, "dev", ["j1", "j2"], verdict({ admit: ["j1"], escalate: { j2: "x" } }), at(3)));
      await store.mutate("pipe", (r) => void engine.decideGate(r, r.gates[0]!.id, decision("admit")));
      return store;
    };
    const off = await run(false);
    const on = await run(true);
    const strip = (r: Run) => ({ ...r, eventSeq: 0 });
    expect(strip(off.get("pipe")!)).toEqual(strip(on.get("pipe")!));
    expect(off.get("pipe")!.eventSeq).toBe(0);
    expect((await off.log.read("pipe")).events).toEqual([]);
  });

  it("keeps a retried ride admitted, and rebuilds the whole log (jobs and admission gates) from its genesis", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "admission-store-"));
    temps.push(dir);
    const store = new RunStore(dir);
    await store.init();
    await store.create(pipeline(await apply()));
    await store.mutate("pipe", (run) => engine.addJob(run, job("j1"), at(1)));
    await store.mutate("pipe", (run) => engine.addJob(run, job("j2"), at(2)));
    await store.mutate("pipe", (run) => void engine.applyAdmission(run, "dev", ["j1", "j2"], verdict({ admit: ["j1"], escalate: { j2: "x" } }), at(3)));
    await store.mutate("pipe", (run) => engine.joinBatch(run, "dev", "t1", ["j1"], at(4)));
    const batch = engine.newBatchRun({ id: "t1", pipeline: store.get("pipe")!, stage: "dev", jobs: store.get("pipe")!.jobs, managerAgentId: "m", now: at(4) });
    await store.mutate("pipe", (run) => void engine.batchEnded(run, { ...batch, status: "failed", failure: "boom" }, at(5)));
    // The failed ride waits again, admitted (a retry is not checked again from scratch).
    expect(heldOf(store.get("pipe")!, "j1")).toMatchObject({ held: null, forced: false });
    await store.mutate("pipe", (run) => void engine.decideGate(run, run.gates[0]!.id, decision("withdraw")));
    const { events } = await store.log.read("pipe");
    expect(verifyLog(EVENT_AREAS, store.get("pipe")!, events)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["job.held", "job.admitted", "job.escalated", "admission.gate_closed"]));
    // The snapshot loads with its defaults.
    expect(RunSchema.parse(JSON.parse(JSON.stringify(store.get("pipe")))).gates[0]).toMatchObject({ kind: "admission", jobId: "j2" });
  });

  it("loads a run saved before admission: waiting entries get held null, gates a null jobId", async () => {
    const saved = JSON.parse(JSON.stringify(pipeline(await apply()))) as Record<string, unknown>;
    saved.jobs = [{ ...job("j1"), waiting: [{ stage: "dev", since: T0 }] }];
    saved.gates = [{ id: "g", kind: "gate", stepId: "s", gotoTarget: null, status: "pending", message: "", requestedAt: T0, comment: null, decidedBy: null, decidedVia: null, decidedAt: null }];
    const legacy = RunSchema.parse(saved);
    expect(legacy.jobs[0]!.waiting[0]).toEqual({ stage: "dev", since: T0, held: null, forced: false });
    expect(legacy.gates[0]!.jobId).toBeNull();
  });

  it("gives a check the oldest waiting jobs within the caps, and says how many were left out", async () => {
    let run = pipeline(await apply());
    for (let index = 0; index < ADMISSION_JOBS_MAX + 20; index++) {
      const copy = structuredClone(run);
      engine.addJob(copy, job(`j${String(index).padStart(3, "0")}`, { pr_urls: "x".repeat(10) }), `2026-11-12T11:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`);
      takeEvents(copy);
      run = copy;
    }
    const given = admissionInput(run, "dev");
    expect(given.jobs).toHaveLength(ADMISSION_JOBS_MAX);
    expect(given.omitted).toBe(20);
    expect(given.jobs[0]).toMatchObject({ id: "j000", label: "PR j000", inputs: { pr_urls: "xxxxxxxxxx" } });
    // Over the character budget: the oldest that fit, long strings cut, at least one.
    const big = pipeline(await apply());
    for (let index = 0; index < 30; index++) engine.addJob(big, job(`big${String(index).padStart(2, "0")}`, { ticket: "y".repeat(500_000) }), at(index));
    const some = admissionInput(big, "dev");
    expect(some.jobs.length).toBeGreaterThanOrEqual(1);
    expect(some.jobs.length).toBeLessThan(12);
    expect(some.omitted).toBe(30 - some.jobs.length);
    expect(some.jobs[0]!.id).toBe("big00");
    expect(String(some.jobs[0]!.inputs.ticket).length).toBeLessThan(11_000);
  });
});

describe("queue.admit: reading the script's answer", () => {
  const ok = (stdout: string) => readAdmission({ code: 0, signal: null }, stdout, "");
  it("reads admit, hold and escalate from the last stdout line (or from outputs), ignoring earlier lines", () => {
    expect(ok('log\n{"admit": ["a"], "hold": {"b": "why"}, "escalate": {"c": "dead"}}\n')).toEqual({ kind: "result", result: { admit: ["a"], hold: { b: "why" }, escalate: { c: "dead" } } });
    expect(ok('{"outputs": {"admit": ["a"]}, "summary": "x"}')).toEqual({ kind: "result", result: { admit: ["a"], hold: {}, escalate: {} } });
    expect(ok("{}")).toEqual({ kind: "result", result: { admit: [], hold: {}, escalate: {} } });
  });
  it("treats exit 75 as not yet, other exits and unreadable output as a failed check", () => {
    expect(readAdmission({ code: 75, signal: null }, "", "")).toEqual({ kind: "not_yet" });
    expect(readAdmission({ code: 2, signal: null }, "", "no token\n")).toEqual({ kind: "failed", message: "exit 2: no token" });
    expect(readAdmission({ code: null, signal: "SIGTERM" }, "", "")).toEqual({ kind: "failed", message: "killed by SIGTERM" });
    expect(ok("just text")).toMatchObject({ kind: "failed", message: expect.stringContaining("no result line") });
    expect(ok('{"admit": "a"}')).toMatchObject({ kind: "failed", message: "admit must be a list of job ids" });
    expect(ok('{"hold": ["a"]}')).toMatchObject({ kind: "failed", message: "hold must map job ids to reasons" });
  });
});

// ------------------------------------------------------------------ runtime

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

async function setup(admit = "{ script: admit.sh, poll: 1h }", wakeGapMs = 100) {
  const dir = await mkdtemp(path.join(tmpdir(), "admission-rt-"));
  temps.push(dir);
  await writePlaybooks(dir, { "apply.yaml": APPLY(admit), "pr.yaml": PR });
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store, { wakeGapMs, admissionTimeoutMs: 1500 });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  const events: BusEvent[] = [];
  runtime.bus.onEmit((event) => void events.push(event));
  const handOff = (n: number, inputs: Record<string, string> = {}) => runtime.startPlaybook({ id: `m${n}`, workspaceId: `ws${n}`, cwd: "/" }, "pr", { pr_url: `https://example.test/pr/${n}`, ...inputs });
  const pipe = () => store.list().find((run) => run.playbook.singleton && run.batch === null)!;
  const checks = async () => (await readFile(path.join(dir, "admit.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const types = (type: string) => events.filter((event) => event.type === type);
  const write = (name: string, body: string) => writeFile(path.join(dir, name), body);
  const status = () => runtime.admissionStatus(pipe().id).dev!;
  const batch = () => store.list().find((run) => run.batch?.stage === "dev");
  return { dir, store, runtime, events, handOff, pipe, checks, types, write, status, batch, ...fake };
}

describe("queue.admit: the runtime", () => {
  it("runs the script in the pipeline's workspace with the waiting jobs, and holds what it does not name", async () => {
    const { dir, handOff, pipe, checks, types, status, batch, runtime } = await setup();
    const parent = await handOff(1, { ticket: "T-1" });
    await until(async () => (await checks()).length === 1 && pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    // First check: nothing named, the job is held with the default reason, and no batch starts.
    expect(pipe().jobs[0]!.waiting[0]!.held).toMatchObject({ reason: "not admitted by the script" });
    expect((await checks())[0]).toBe(`1 dev apply ${pipe().id} dev ${await realpathOf(dir)}`);
    const seen = JSON.parse(await readFile(path.join(dir, "jobs-seen.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(seen).toEqual([{ id: pipe().jobs[0]!.id, label: expect.any(String), since: expect.any(String), inputs: { pr_url: "https://example.test/pr/1", ticket: "T-1" } }]);
    expect(await readFile(path.join(dir, "omitted-seen"), "utf8")).toBe("0\n");
    await sleep(300);
    expect(batch()).toBeUndefined();
    expect(types("job.held")).toHaveLength(1);
    expect(types("job.held")[0]!.payload).toMatchObject({ jobId: pipe().jobs[0]!.id, stage: "dev", reason: "not admitted by the script", playbook: "apply" });
    expect(status()).toMatchObject({ running: false, checks: 1, lastOutcome: "ok", error: null });
    expect(status().nextCheckAt).not.toBeNull();
    expect(runtime.attention().gates).toEqual([]);
    expect(parent.status).toBeDefined();
  });

  it("admits what the script names, which joins the next batch; job.admitted says via script", async () => {
    const { handOff, pipe, write, checks, types, batch, runtime } = await setup("{ script: admit.sh, poll: 1h, wake_on: [{ types: [job.settled], filter: { playbook: other } }] }");
    await handOff(1);
    await until(async () => (await checks()).length === 1 && pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    const id = pipe().jobs[0]!.id;
    await write("verdict.json", JSON.stringify({ admit: [id] }));
    await runtime.bus.emit("job.settled", { runId: "x", playbook: "other", runName: null, projectId: "p", workspaceDir: "/", jobId: "z", label: "z", stage: "stg", batchRunId: null, station: "stg", trainRunId: null, outcome: "done", summary: null }, { runId: "x", source: "pipelines" });
    await until(() => batch() !== undefined && pipe().jobs[0]!.batches.length === 1);
    expect(pipe().jobs[0]).toMatchObject({ waiting: [], batches: [expect.objectContaining({ stage: "dev" })] });
    expect(types("job.admitted")).toHaveLength(1);
    expect(types("job.admitted")[0]!.payload).toMatchObject({ jobId: id, stage: "dev", via: "script", reason: null });
    expect(types("job.joined")).toHaveLength(1);
    // The queue is empty now: no more checks, even on a wake-up.
    const before = (await checks()).length;
    await runtime.bus.emit("job.settled", { runId: "x", playbook: "other", runName: null, projectId: "p", workspaceDir: "/", jobId: "z", label: "z", stage: "stg", batchRunId: null, station: "stg", trainRunId: null, outcome: "done", summary: null }, { runId: "x", source: "pipelines" });
    await sleep(400);
    expect((await checks()).length).toBe(before);
  });

  it("wakes on a new job of its own queue without a wake_on, and says why", async () => {
    const { handOff, pipe, write, checks, runtime, status } = await setup();
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    await handOff(2);
    await until(async () => (await checks()).length >= 2);
    await until(() => pipe().jobs.length === 2 && pipe().jobs[1]!.waiting[0]!.held?.checkedAt != null);
    const second = (await checks())[1]!;
    expect(second.split(" ")[0]).toBe("2");
    const seen = JSON.parse(await readFile(path.join(pipe().workspaceDir, "jobs-seen.json"), "utf8")) as Array<{ id: string }>;
    expect(seen.map((entry) => entry.id)).toEqual(pipe().jobs.map((entry) => entry.id));
    void write;
    void runtime;
    void status;
  });

  it("does not wake itself with the events its own check makes (job.held, job.admitted, job.escalated)", async () => {
    const { handOff, pipe, checks, types } = await setup("{ script: admit.sh, poll: 1h, wake_on: [{ types: [\"job.*\"], filter: { playbook: apply } }] }", 50);
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    await sleep(400);
    const settled = (await checks()).length;
    // The job.held the check made (and the job.queued that raced it: at most one more check) end there: no loop.
    expect(settled).toBeLessThanOrEqual(2);
    await sleep(600);
    expect((await checks()).length).toBe(settled);
    expect(types("job.held")).toHaveLength(1);
  });

  it("leaves everything as it is on exit 75, and shows a failed check (exit, no result, timeout) as an alert", async () => {
    const { handOff, pipe, write, checks, status, runtime } = await setup("{ script: admit.sh, poll: 1h, wake_on: [{ types: [job.settled], filter: { playbook: other } }] }");
    const wake = () => runtime.bus.emit("job.settled", { runId: "x", playbook: "other", runName: null, projectId: "p", workspaceDir: "/", jobId: "z", label: "z", stage: "stg", batchRunId: null, station: "stg", trainRunId: null, outcome: "done", summary: null }, { runId: "x", source: "pipelines" });
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    const held = structuredClone(pipe().jobs[0]!.waiting[0]!.held);
    await write("exit", "75");
    await wake();
    await until(async () => (await checks()).length === 2);
    await until(() => status().lastOutcome === "not_yet");
    expect(status().error).toBeNull();
    expect(pipe().jobs[0]!.waiting[0]!.held).toEqual(held);
    await write("exit", "3");
    await sleep(150);
    await wake();
    await until(() => status().lastOutcome === "failed");
    expect(status().error).toMatchObject({ message: "exit 3: boom on stderr", tail: expect.stringContaining("boom on stderr") });
    expect(status().checks).toBe(3);
    expect(pipe().jobs[0]!.waiting[0]!.held).toEqual(held);
    // The next good check clears it.
    await rmQuiet(path.join(pipe().workspaceDir, "exit"));
    await sleep(150);
    await wake();
    await until(() => status().lastOutcome === "ok");
    expect(status().error).toBeNull();
    // Unreadable output: failed too.
    await write("verdict.json", "not json at all");
    await sleep(150);
    await wake();
    await until(() => status().lastOutcome === "failed");
    expect(status().error!.message).toMatch(/no result line/);
    // A script that runs too long is killed.
    await rmQuiet(path.join(pipe().workspaceDir, "verdict.json"));
    await write("slow", "");
    const slowRuntime = runtime as unknown as { options: { admissionTimeoutMs?: number } };
    slowRuntime.options.admissionTimeoutMs = 100;
    await sleep(150);
    await wake();
    await until(() => status().lastOutcome === "failed" && /timed out/.test(status().error?.message ?? ""), 4000);
  });

  it("fails the check visibly when the script is missing from the pipeline's workspace", async () => {
    const { dir, handOff, status, pipe, runtime } = await setup("{ script: admit.sh, poll: 1h, wake_on: [{ types: [job.settled], filter: { playbook: other } }] }");
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    await rm(path.join(dir, ".paseo/plugins/playbooks/scripts/admit.sh"));
    await runtime.bus.emit("job.settled", { runId: "x", playbook: "other", runName: null, projectId: "p", workspaceDir: "/", jobId: "z", label: "z", stage: "stg", batchRunId: null, station: "stg", trainRunId: null, outcome: "done", summary: null }, { runId: "x", source: "pipelines" });
    await until(() => status().lastOutcome === "failed");
    expect(status().error!.message).toMatch(/admit\.sh not found in the pipeline's workspace/);
    expect(pipe().jobs[0]!.waiting[0]!.held!.reason).toBe("not admitted by the script");
  });

  it("ignores an id the script invented, with a warning in the status", async () => {
    const { handOff, pipe, write, status, runtime } = await setup("{ script: admit.sh, poll: 1h, wake_on: [{ types: [job.settled], filter: { playbook: other } }] }");
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    await write("verdict.json", JSON.stringify({ hold: { ghost: "who?", [pipe().jobs[0]!.id]: "real" } }));
    await runtime.bus.emit("job.settled", { runId: "x", playbook: "other", runName: null, projectId: "p", workspaceDir: "/", jobId: "z", label: "z", stage: "stg", batchRunId: null, station: "stg", trainRunId: null, outcome: "done", summary: null }, { runId: "x", source: "pipelines" });
    await until(() => status().warnings.length === 1);
    expect(status().warnings[0]).toMatch(/unknown job id "ghost"/);
    expect(pipe().jobs[0]!.waiting[0]!.held!.reason).toBe("real");
  });

  it("escalates: one ask in list_gates, answered by retry (checks again), admit (joins) or withdraw", async () => {
    const { handOff, pipe, write, checks, types, status, batch, runtime, store } = await setup();
    await runtime.watchEvents();
    const parent = await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    const id = pipe().jobs[0]!.id;
    await write("verdict.json", JSON.stringify({ escalate: { [id]: "dependency failed" } }));
    // Make the script run again through the stage's own wake-up (a second job).
    await handOff(2);
    await until(() => pipe().gates.length === 1);
    expect(types("job.escalated")).toHaveLength(1);
    expect(types("job.escalated")[0]!.payload).toMatchObject({ jobId: id, stage: "dev", reason: "dependency failed", gateId: pipe().gates[0]!.id });
    expect(types("gate.opened")).toHaveLength(0);
    await runtime.watchEvents();
    expect(types("gate.opened")[0]!.payload).toMatchObject({ kind: "admission", jobId: id, stepId: "dev", choices: [{ id: "retry" }, { id: "withdraw" }, { id: "admit" }] });
    expect(runtime.attention().gates).toEqual([expect.objectContaining({ kind: "admission", jobId: id, waitingForHuman: true, question: expect.stringContaining("cannot be admitted at Dev: dependency failed") })]);
    // Several checks with the same verdict never open another ask.
    const gate = pipe().gates[0]!;
    const count = (await checks()).length;
    await runtime.decideGate(pipe().id, gate.id, { decision: "retry", comment: null, by: "Ada", via: "panel", now: new Date().toISOString() });
    await until(async () => (await checks()).length > count);
    await sleep(150);
    expect(pipe().gates.filter((candidate) => candidate.status === "pending")).toHaveLength(1);
    expect(pipe().gates).toHaveLength(2);
    expect(pipe().gates[0]).toMatchObject({ status: "retry" });
    expect(pipe().jobs[0]!.waiting[0]!.held!.reason).toBe("dependency failed");
    // Withdraw: the job leaves the pipeline; its run handed it off and is not told.
    const open = pipe().gates.find((candidate) => candidate.status === "pending")!;
    await runtime.decideGate(pipe().id, open.id, { decision: "withdraw", comment: "not shipping", by: "Ada", via: "panel", now: new Date().toISOString() });
    expect(pipe().jobs[0]).toMatchObject({ status: "withdrawn" });
    expect(pipe().jobs[0]!.summary).toContain("withdrawn from the \"Dev\" queue by Ada: not shipping");
    expect(store.get(parent.id)!.steps.apply!.attempts.at(-1)).toMatchObject({ report: { outcome: "done" } });
    expect(types("job.withdrawn")).toHaveLength(1);
    expect(batch()).toBeUndefined();
    void status;
  });

  it("admit anyway joins the job and the script no longer holds it", async () => {
    const { handOff, pipe, write, types, batch, runtime } = await setup();
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    const id = pipe().jobs[0]!.id;
    await write("verdict.json", JSON.stringify({ escalate: { [id]: "dependency failed" } }));
    await handOff(2);
    await until(() => pipe().gates.length === 1);
    await runtime.decideGate(pipe().id, pipe().gates[0]!.id, { decision: "admit", comment: "I checked", by: "Ada", via: "panel", now: new Date().toISOString() });
    await until(() => batch() !== undefined);
    expect(batch()!.jobs.map((job) => job.id)).toEqual([id]);
    expect(types("job.admitted").at(-1)!.payload).toMatchObject({ jobId: id, via: "human", reason: "I checked" });
    // The other job is still held: only one joins at a time (fifo), and the escalated one was the oldest.
    expect(pipe().jobs[1]!.waiting[0]!.held).not.toBeNull();
  });

  it("coalesces a burst of events into one more check, never two at once, and reruns after a restart", async () => {
    const { dir, store, handOff, pipe, write, checks, runtime } = await setup("{ script: admit.sh, poll: 1h, wake_on: [{ types: [job.settled], filter: { playbook: other } }] }", 100);
    await handOff(1);
    await until(() => pipe().jobs[0]?.waiting[0]?.held?.checkedAt != null);
    await write("slow", "");
    const wake = () => runtime.bus.emit("job.settled", { runId: "x", playbook: "other", runName: null, projectId: "p", workspaceDir: "/", jobId: "z", label: "z", stage: "stg", batchRunId: null, station: "stg", trainRunId: null, outcome: "done", summary: null }, { runId: "x", source: "pipelines" });
    await sleep(150);
    await wake();
    await until(async () => (await checks()).length === 2);
    for (let i = 0; i < 10; i++) await wake();
    await until(async () => (await checks()).length === 3);
    await sleep(900);
    expect((await checks()).length).toBe(3);
    // A restart: a new runtime over the same files runs the check again (idempotent), the job still held.
    await runtime.dispose();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const store2 = new RunStore(path.join(dir, "runs"));
    await store2.init();
    const again = new Runtime(store2, { wakeGapMs: 100 });
    runtimes.push(again);
    await again.attach(fakePaseo(dir).paseo as never);
    await until(async () => (await checks()).length === 4);
    expect(store2.list().find((run) => run.batch === null)!.jobs[0]!.waiting[0]!.held!.reason).toBe("not admitted by the script");
    void store;
  });
});

async function rmQuiet(file: string) {
  await rm(file, { force: true });
}

async function realpathOf(dir: string) {
  const { realpath } = await import("node:fs/promises");
  return realpath(dir);
}
