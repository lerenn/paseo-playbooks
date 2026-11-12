import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { EVENT_AREAS, RunStore } from "./store";
import * as engine from "./engine";
import { verifyLog } from "./event-core";
import { checkTypes, matchesFilter } from "./bus";
import { JOB_TYPES } from "./job-events";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Just enough of the daemon API: idle agents, recorded prompts, and worktrees that share the test folder. */
function fakePaseo(dir: string, pipelineDir = dir) {
  const archivedWorkspaces: string[] = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ title: string; source: unknown }> = [];
  const archived: string[] = [];
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
    archive: async () => void archived.push(agentId),
  });
  const createAgent = async () => {
    const id = `mgr${++agents}`;
    return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
  };
  const workspace = (id: string) => ({ id, projectId: "p", workspaceDirectory: id.startsWith("wt") ? pipelineDir : dir });
  const paseo = {
    agents: { ref },
    workspaces: {
      ref: (id: string) => ({ refresh: async () => workspace(id), agents: { create: createAgent }, archive: async () => void archivedWorkspaces.push(id) }),
      create: async (input: { title: string; source: unknown }) => {
        created.push(input);
        return { id: `wt${created.length}`, agents: { create: createAgent } };
      },
    },
  };
  return { paseo, sent, created, archived, archivedWorkspaces };
}

const APPLY = `
title: Apply
singleton: { branch: main }
inputs:
  pr_url: { type: string, required: true }
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

const PR = `
title: PR
inputs:
  pr_url: { type: string, required: true }
steps:
  - id: apply
    handoff: { name: apply }
    inputs: { pr_url: ~ }
`;

async function setup(files: Record<string, string> = { "apply.yaml": APPLY, "pr.yaml": PR }, pipelineDir?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "singleton-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir, pipelineDir);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, store, runtime, ...fake };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function errorsOf(files: Record<string, string>, id: string): Promise<string> {
  const { dir } = await setup(files);
  return ((await loadPlaybooks(dir)).entries.find((entry) => entry.id === id)?.errors ?? []).join("\n");
}


const now = () => new Date().toISOString();

/** The running batch of a stage, once it has started. */
function batchAt(store: RunStore, stage: string) {
  return store.list().find((run) => run.batch?.stage === stage && (run.status === "running" || run.status === "waiting_gate"));
}

/** The stage's gate decides its batch: approve passes its jobs on, reject fails the batch. */
async function decide(runtime: Runtime, store: RunStore, stage: string, decision: "approved" | "rejected") {
  const batch = batchAt(store, stage)!;
  await runtime.requestGate(batch.managerAgentId, batch.id, stage, "ok?", "");
  await runtime.decideGate(batch.id, stage, { decision, comment: null, by: null, via: "panel", now: now() });
  return batch;
}

function pipelineOf(store: RunStore) {
  return store.list().find((run) => run.playbook.singleton && run.batch === null)!;
}

describe("singleton pipelines: validation", () => {
  it("load stages from the top-level steps, and the hand-off's contract from the singleton", async () => {
    const { dir } = await setup();
    const entries = (await loadPlaybooks(dir)).entries;
    const apply = entries.find((entry) => entry.id === "apply")!;
    const pr = entries.find((entry) => entry.id === "pr")!;
    expect(apply.errors).toEqual([]);
    expect(pr.errors).toEqual([]);
    expect(apply.playbook!.singleton).toEqual({
      branch: "main",
      stages: [
        { id: "dev", title: "Dev", needs: [], mode: "merge", retries: 1, effects: {}, steps: ["dev"] },
        { id: "prd", title: "Prd", needs: ["dev"], mode: "fifo", retries: 0, effects: {}, steps: ["prd"] },
      ],
    });
    expect(pr.playbook!.steps[0]).toMatchObject({ kind: "handoff", handoff: "apply", outcomes: ["done", "rejected", "failure"] });
  });

  it("expand a sub-playbook stage, with its constant inputs reaching `when` inside it", async () => {
    const { dir } = await setup({
      "batch.yaml": `
title: Batch
hidden: true
inputs:
  env: { type: enum, values: [dev, prd], required: true }
steps:
  - id: go
    when: { env: prd }
    gate: { question: Go? }
  - id: check
    needs: [go]
    gate: { question: Checked? }
`,
      "batches.yaml": `
title: Batches
singleton: {}
inputs:
  pr_url: { type: string, required: true }
steps:
  - id: dev
    playbook: { name: batch }
    inputs: { env: dev }
  - id: prd
    needs: [dev]
    playbook: { name: batch }
    inputs: { env: prd }
`,
    });
    const batches = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "batches")!;
    expect(batches.errors).toEqual([]);
    expect(batches.playbook!.singleton!.stages.map((stage) => [stage.id, stage.steps])).toEqual([
      ["dev", ["dev.go", "dev.check"]],
      ["prd", ["prd.go", "prd.check"]],
    ]);
    expect(batches.playbook!.steps.find((step) => step.id === "prd.go")!.when).toEqual([{ input: "env", source: "prd", values: ["prd"] }]);
  });

  it("refuse the v0.30.0 concurrency, `queue` outside a singleton, an editing role, a goto between stages, and `after`", async () => {
    const old = await errorsOf({ "apply.yaml": "title: A\nsingleton: { concurrency: { key: [env] } }\nsteps:\n  - id: a\n    gate: { question: ok }\n" }, "apply");
    expect(old).toMatch(/singleton.concurrency was removed: each top-level step is a stage/);
    const queue = await errorsOf({ "w.yaml": "title: W\nsteps:\n  - id: a\n    gate: { question: ok }\n    queue: { mode: merge }\n" }, "w");
    expect(queue).toMatch(/`queue` only applies to a step of a singleton playbook/);
    const editing = await errorsOf({ "s.yaml": "title: S\nsingleton: {}\nsteps:\n  - id: a\n    role: { name: implementer }\n" }, "s");
    expect(editing).toMatch(/role "implementer" is not readonly; a singleton's batches share one workspace/);
    const back = await errorsOf(
      { "s.yaml": "title: S\nsingleton: {}\nsteps:\n  - id: a\n    gate: { question: ok }\n  - id: b\n    needs: [a]\n    gate: { question: ok, choices: { ok: ~, again: ~ } }\n    on: { again: { goto: a } }\n" },
      "s",
    );
    expect(back).toMatch(/goto "a" leaves stage "b"; jobs only move forward/);
    const after = await errorsOf({ "s.yaml": "title: S\nsingleton: {}\nsteps:\n  - id: a\n    gate: { question: ok }\nafter:\n  - id: r\n    gate: { question: ok }\n" }, "s");
    expect(after).toMatch(/`after` does not apply to a singleton playbook/);
    const across = await errorsOf(
      { "s.yaml": "title: S\nsingleton: {}\nsteps:\n  - id: a\n    role: { name: reviewer }\n    outputs: { tag: {} }\n  - id: b\n    needs: [a]\n    role: { name: reviewer }\n    inputs: [tag]\n" },
      "s",
    );
    expect(across).toMatch(/reads step "a" of another stage/);
  });

  it("refuse reading a job's input from a step, `when` on it, a hand-off to a non-singleton, a singleton sub-playbook, and a loop of hand-offs", async () => {
    const reading = await errorsOf({ "s.yaml": "title: S\nsingleton: {}\ninputs:\n  pr_url: { type: string }\nsteps:\n  - id: a\n    role: { name: reviewer }\n    inputs: [pr_url]\n" }, "s");
    expect(reading).toMatch(/inputs.pr_url: "pr_url" is each job's input/);
    const when = await errorsOf({ "s.yaml": "title: S\nsingleton: {}\ninputs:\n  env: { type: string }\nsteps:\n  - id: a\n    gate: { question: ok }\n    when: { env: dev }\n" }, "s");
    expect(when).toMatch(/when.env: a singleton's inputs are each job's/);
    const plain = await errorsOf({ "plain.yaml": "title: Plain\nsteps:\n  - id: a\n    gate: { question: ok }\n", "pr.yaml": "title: PR\nsteps:\n  - id: h\n    handoff: { name: plain }\n" }, "pr");
    expect(plain).toMatch(/handoff: playbook "plain" is not a singleton/);
    const sub = await errorsOf({ "apply.yaml": APPLY, "outer.yaml": "title: Outer\nsteps:\n  - id: s\n    playbook: { name: apply }\n" }, "outer");
    expect(sub).toMatch(/playbook "apply" is a singleton: .* cannot be a sub-playbook; use `handoff: \{ name: apply \}`/);
    const loop = await errorsOf(
      { "a.yaml": "title: A\nsingleton: {}\nsteps:\n  - id: h\n    handoff: { name: b }\n", "b.yaml": "title: B\nsingleton: {}\nsteps:\n  - id: h\n    handoff: { name: a }\n" },
      "a",
    );
    expect(loop).toMatch(/leads back to this playbook/);
    expect(await errorsOf({ "a.yaml": "title: A\nsingleton: true\nsteps:\n  - id: g\n    gate: { question: ok }\n" }, "a")).toMatch(/singleton: a feature is a block/);
  });
});

const FORGET = `
title: Forget
inputs:
  pr_url: { type: string, required: true }
steps:
  - id: apply
    handoff: { name: apply }
    inputs: { pr_url: ~ }
  - id: after
    needs: [apply]
    gate: { question: Next? }
`;

describe("singleton pipelines: a hand-off gives the task away", () => {
  it("have no outputs, refuse `on`, `outputs`, `wait` and reading its outputs, each with the new model", async () => {
    const { dir } = await setup({ "apply.yaml": APPLY, "forget.yaml": FORGET });
    const forget = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "forget")!;
    expect(forget.errors).toEqual([]);
    expect(forget.playbook!.steps[0]).toMatchObject({ kind: "handoff", outputs: {} });
    const onOther = await errorsOf({ "apply.yaml": APPLY, "f.yaml": FORGET.replace("    inputs: { pr_url: ~ }\n", "    inputs: { pr_url: ~ }\n    on: { rejected: fail }\n") }, "f");
    expect(onOther).toMatch(/a hand-off has no `on`: it gives the job away/);
    const outs = await errorsOf({ "apply.yaml": APPLY, "f.yaml": FORGET.replace("    inputs: { pr_url: ~ }\n", "    inputs: { pr_url: ~ }\n    outputs: { report: {} }\n") }, "f");
    expect(outs).toMatch(/a hand-off has no outputs: it gives the job to the other playbook and this run does not wait/);
    const wait = await errorsOf({ "apply.yaml": APPLY, "f.yaml": FORGET.replace("{ name: apply }", "{ name: apply, wait: true }") }, "f");
    expect(wait).toMatch(/handoff.wait was removed: a hand-off never waits.*Write `handoff: \{ name: apply \}`/);
    const reading = await errorsOf(
      { "apply.yaml": APPLY, "f.yaml": FORGET.replace("    gate: { question: Next? }", "    role: { name: reviewer }\n    inputs: { report: \"{{ steps.apply.outputs.report }}\" }") },
      "f",
    );
    expect(reading).toMatch(/step "apply" has no output "report" \(a hand-off gives the job to another playbook and does not wait for it, so it has no outputs\)/);
  });

  it("complete at once, leave the job to the pipeline when the run ends, and never tell the run how it ends", async () => {
    const { store, runtime, sent } = await setup({ "apply.yaml": APPLY, "forget.yaml": FORGET });
    const run = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "forget", { pr_url: "1" });
    await until(() => store.get(run.id)!.steps.apply!.status === "completed");
    expect(store.get(run.id)!.steps.apply!.attempts.at(-1)).toMatchObject({ outcome: "done", job: { runId: pipelineOf(store).id } });
    expect(store.get(run.id)!.steps.after!.status).toBe("ready");
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "open", detached: true, fromRunId: run.id, fromStepId: "apply" });
    await runtime.cancelRun(run.id, "moved on", null);
    expect(pipelineOf(store).jobs[0]!.status).toBe("open");
    // The batch still carries it; a gate there is not announced to the canceled run, and ejecting it records on the pipeline only.
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    expect(dev.jobs[0]!.detached).toBe(true);
    await runtime.requestGate(dev.managerAgentId, dev.id, "dev", "Applied?", "");
    await runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { outcome: "rejected", summary: "broke dev", outputs: {} });
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "settled", outcome: "rejected" });
    expect(store.get(run.id)!.status).toBe("canceled");
    expect(sent.filter((entry) => entry.agentId === "m1" && /waits for a human|ended rejected/.test(entry.text))).toHaveLength(0);
  });

  it("let a batch's manager start rework in a new workspace with start_playbook", async () => {
    const { store, runtime, created, sent } = await setup({ "apply.yaml": APPLY, "forget.yaml": FORGET });
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "forget", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    expect(sent.find((entry) => entry.agentId === dev.managerAgentId)!.text).toMatch(/start_playbook with newWorkspace: true/);
    await expect(runtime.startPlaybook({ id: dev.managerAgentId, workspaceId: dev.workspaceId, cwd: "/" }, "forget", { pr_url: "1" })).rejects.toThrow(/already has an active run/);
    const started = await runtime.startPlaybookElsewhere({ workspaceId: dev.workspaceId, cwd: "/" }, "forget", { pr_url: "1" });
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ title: "Forget: 1", source: { kind: "worktree", action: "branch-off" } });
    expect(runtime.hasReservation(started.workspaceId)).toBe(true);
    await expect(runtime.startPlaybookElsewhere({ workspaceId: dev.workspaceId, cwd: "/" }, "apply", {})).rejects.toThrow(/is a singleton/);
  });
  it("titles the new workspace with workspaceName (sanitized), never changing the branch, in start_playbook and the panel RPC", async () => {
    const { store, runtime, created } = await setup({ "apply.yaml": APPLY, "forget.yaml": FORGET });
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "forget", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    await runtime.startPlaybookElsewhere({ workspaceId: dev.workspaceId, cwd: "/" }, "forget", { pr_url: "1" }, "  My \n named   workspace ");
    expect(created.at(-1)).toMatchObject({ title: "My named workspace", source: { branchName: expect.stringMatching(/^playbooks\/forget-/) } });
    const viaPanel = await runtime.startFromPanel({ workspaceId: dev.workspaceId, playbook: "forget", inputs: { pr_url: "2" }, force: false, workspaceName: "Panel name" });
    expect(viaPanel.status).toBe("started");
    expect(created.at(-1)).toMatchObject({ title: "Panel name" });
    // An empty name keeps today's default title.
    await runtime.startFromPanel({ workspaceId: dev.workspaceId, playbook: "forget", inputs: { pr_url: "3" }, force: false, workspaceName: "   " });
    expect(created.at(-1)).toMatchObject({ title: "Forget: 3" });
    // It only names a new workspace.
    await expect(runtime.startFromPanel({ workspaceId: dev.workspaceId, playbook: "forget", inputs: { pr_url: "4" }, force: false, sameWorkspace: true, workspaceName: "x" })).rejects.toThrow(/workspaceName/);
    await expect(runtime.startPlaybookInWorkspace({ id: "m1", workspaceId: "ws1" }, { playbook: "forget", inputs: {}, workspaceId: dev.workspaceId, newWorkspace: false, workspaceName: "x" })).rejects.toThrow(/with newWorkspace/);
  });
  it("give a batch's manager the repository's, the pipeline's and its own stage's instructions only", async () => {
    const { store, runtime, sent } = await setup({
      "deploy.yaml": `
title: Deploy
singleton: {}
inputs:
  pr_url: { type: string, required: true }
manager: { prompt: One batch at a time. }
steps:
  - { id: dev, playbook: { name: on_dev } }
  - { id: prd, playbook: { name: on_prd }, needs: [dev] }
`,
      "on_dev.yaml": "hidden: true\nmanager: { prompt: Dev is cheap. }\nsteps:\n  - id: ok\n    gate: { question: ok? }\n",
      "on_prd.yaml": "hidden: true\nmanager: { prompt: Prd needs care. }\nsteps:\n  - id: ok\n    gate: { question: ok? }\n",
      "pr.yaml": "title: PR\ninputs:\n  pr_url: { type: string, required: true }\nsteps:\n  - { id: deploy, handoff: { name: deploy }, inputs: { pr_url: ~ } }\n",
      "defaults/manager.md": "Write in English.",
    });
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const kickoff = sent.find((entry) => entry.agentId === batchAt(store, "dev")!.managerAgentId)!.text;
    expect(kickoff).toContain("- repository: Write in English.\n- deploy: One batch at a time.\n- on_dev: Dev is cheap.");
    expect(kickoff).not.toContain("Prd needs care.");
  });
});

describe("singleton pipelines: jobs through the stages", () => {
  it("create the pipeline and its workspace once, run each stage's batch, and settle the job on the pipeline", async () => {
    const { store, runtime, created, sent } = await setup();
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "https://x/pull/1" });
    await until(() => batchAt(store, "dev") !== undefined);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Apply", source: { kind: "worktree", action: "branch-off", refName: "main" } });
    const dev = batchAt(store, "dev")!;
    expect(dev.jobs.map((job) => job.inputs.pr_url)).toEqual(["https://x/pull/1"]);
    expect(dev.workspaceId).toBe(pipelineOf(store).workspaceId);
    expect(sent.find((entry) => entry.agentId === dev.managerAgentId)!.text).toMatch(/batch of stage "dev"/);
    // Outputs set on dev, read later; the job goes on.
    await runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { summary: "", outputs: { report: "dev ok" } });
    await decide(runtime, store, "dev", "approved");
    await until(() => batchAt(store, "prd") !== undefined);
    expect(batchAt(store, "prd")!.jobs[0]!.outputs).toEqual({ report: "dev ok" });
    // The hand-off gave the job away: its run is done at once and gets nothing back.
    expect(store.get(pr.id)!.status).toBe("completed");
    await decide(runtime, store, "prd", "approved");
    await until(() => pipelineOf(store).jobs[0]!.status === "settled");
    expect(store.get(pr.id)!.steps.apply!.outputs).toEqual({});
    expect(created).toHaveLength(1);
  });

  it("merge: jobs that piled up ride the next batch together; fifo: one at a time", async () => {
    const { store, runtime } = await setup();
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    await runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "pr", { pr_url: "2" });
    await runtime.startPlaybook({ id: "m3", workspaceId: "ws3", cwd: "/" }, "pr", { pr_url: "3" });
    const first = await decide(runtime, store, "dev", "approved");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== first.id);
    expect(batchAt(store, "dev")!.jobs.map((job) => job.inputs.pr_url)).toEqual(["2", "3"]);
    // prd is fifo: job 1 alone, then the others one by one.
    await until(() => batchAt(store, "prd") !== undefined);
    expect(batchAt(store, "prd")!.jobs.map((job) => job.inputs.pr_url)).toEqual(["1"]);
  });

  it("keep one manager per stage: the previous batch's is archived when the next leaves", async () => {
    const { store, runtime, archived } = await setup();
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    await runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "pr", { pr_url: "2" });
    // Its manager is idle: it is archived right away.
    await runtime.onManagerTurnEnded(batchAt(store, "dev")!.managerAgentId);
    const first = await decide(runtime, store, "dev", "approved");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== first.id);
    expect(archived).toContain(first.managerAgentId);
  });

  it("archive a busy previous manager only when its turn ends, and never wake it again", async () => {
    const { store, runtime, archived, sent } = await setup();
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    await runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "pr", { pr_url: "2" });
    // Its manager is still in its turn (here the kickoff's) when its batch ends.
    const first = batchAt(store, "dev")!;
    await decide(runtime, store, "dev", "approved");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== first.id);
    expect(archived).not.toContain(first.managerAgentId);
    await store.mutate(first.id, (run) => void run.inbox.push("late note"));
    const before = sent.filter((entry) => entry.agentId === first.managerAgentId).length;
    await runtime.onManagerTurnEnded(first.managerAgentId);
    expect(archived).toContain(first.managerAgentId);
    expect(sent.filter((entry) => entry.agentId === first.managerAgentId)).toHaveLength(before);
  });

  it("fail the hand-off and archive the new workspace when its branch has no such singleton", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "singleton-branch-"));
    temps.push(empty);
    const { store, runtime, created, archivedWorkspaces } = await setup(undefined, empty);
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => store.get(pr.id)!.status === "failed");
    expect(store.get(pr.id)!.steps.apply!.attempts.at(-1)!.report?.summary).toMatch(/no playbook "apply" on main/);
    expect(created).toHaveLength(1);
    expect(archivedWorkspaces).toEqual(["wt1"]);
  });

  it("settle jobs from a step's `settle` output when it completes, and refuse entries that do not apply", async () => {
    const release = `
title: Release
singleton: { branch: main }
inputs:
  pr_url: { type: string, required: true }
outputs:
  report: { type: string }
outcomes: [done, skipped_out]
steps:
  - id: dev
    role: { name: reviewer, prompt: "{{ run.jobs }}" }
    outputs: { job_results: {} }
    outcomes: [success, empty]
    settle: { output: job_results }
    on:
      empty: end
`;
    const handing = `
title: PR
inputs:
  pr_url: { type: string, required: true }
steps:
  - id: apply
    handoff: { name: release }
    inputs: { pr_url: ~ }
`;
    expect(await errorsOf({ "r.yaml": release.replace("outputs: { job_results: {} }", "outputs: { job_results: { type: number } }") }, "r")).toMatch(/settle.output "job_results" must be a string output/);
    expect(await errorsOf({ "r.yaml": release.replace("outputs: { job_results: {} }", "outputs: { other: {} }") }, "r")).toMatch(/settle.output "job_results" is not an output of the step/);
    expect(await errorsOf({ "g.yaml": "title: G\nsteps:\n  - id: a\n    gate: { question: ok? }\n    settle: { output: x }\n" }, "g")).toMatch(/`settle` only applies to a role or script step/);

    const { store, runtime } = await setup({ "release.yaml": release, "pr.yaml": handing });
    const one = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    const job = dev.jobs[0]!.id;
    await runtime.startStep(dev.managerAgentId, dev.id, "dev", "");
    await expect(runtime.completeStep(dev.managerAgentId, dev.id, "dev", { outcome: "empty", outputs: { job_results: `job_nope: { outcome: skipped_out }` } })).rejects.toThrow(/settle.output "job_results" of "dev": job "job_nope" is not on this batch/);
    await expect(runtime.completeStep(dev.managerAgentId, dev.id, "dev", { outcome: "empty", outputs: { job_results: `${job}: { outcome: maybe }` } })).rejects.toThrow(/outcome "maybe" is not an outcome of "release"/);
    expect(store.get(dev.id)!.steps.dev!.status).toBe("running");
    // The manager does not call settle_job: the plugin ends the job from the output, then the batch ends.
    await runtime.completeStep(dev.managerAgentId, dev.id, "dev", { outcome: "empty", outputs: { job_results: `# nothing to deploy\n${job}:\n  outcome: skipped_out\n  reason: docs only` } });
    await until(() => pipelineOf(store).jobs[0]!.outcome === "skipped_out");
    expect(store.get(one.id)!.steps.apply!.attempts.at(-1)!.outcome).toBe("done");
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "settled", outcome: "skipped_out", summary: "docs only", passed: [] });
  });

  it("requeue a job from a step's `settle` output by a declared outcome: the batch ends without it, no failed ride, and a later batch takes it", async () => {
    const release = `
title: Release
singleton: { branch: main }
inputs:
  pr_url: { type: string, required: true }
outputs:
  report: { type: string }
outcomes: [done, blocked]
steps:
  - id: dev
    role: { name: reviewer, prompt: "{{ run.jobs }}" }
    outputs: { job_results: {} }
    queue: { mode: merge, max_requeues: 2 }
    settle: { output: job_results, effects: { blocked: requeue } }
`;
    const handing = `
title: PR
inputs:
  pr_url: { type: string, required: true }
steps:
  - id: apply
    handoff: { name: release }
    inputs: { pr_url: ~ }
`;
    // The effect is declared in the playbook, checked at load.
    expect(await errorsOf({ "r.yaml": release.replace("blocked: requeue", "nope: requeue") }, "r")).toMatch(/settle.effects.nope: not an outcome of this playbook/);
    expect(await errorsOf({ "r.yaml": release.replace("blocked: requeue", "done: requeue") }, "r")).toMatch(/settle.effects.done: the first outcome is the normal finish/);
    expect(await errorsOf({ "r.yaml": release.replace("blocked: requeue", "blocked: fly") }, "r")).toMatch(/Invalid option/);
    expect(await errorsOf({ "r.yaml": release.replace("max_requeues: 2", "max_requeues: 2").replace("settle: { output: job_results, effects: { blocked: requeue } }", "settle: { output: job_results }") }, "r")).toMatch(/queue.max_requeues: no `settle.effects`/);
    const { store, runtime } = await setup({ "release.yaml": release, "pr.yaml": handing });
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "https://x/pull/1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const alone = batchAt(store, "dev")!;
    await runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "pr", { pr_url: "https://x/pull/2" });
    await runtime.startPlaybook({ id: "m3", workspaceId: "ws3", cwd: "/" }, "pr", { pr_url: "https://x/pull/3" });
    await runtime.startStep(alone.managerAgentId, alone.id, "dev", "");
    await runtime.completeStep(alone.managerAgentId, alone.id, "dev", { outcome: "success", outputs: { job_results: `${alone.jobs[0]!.id}: { outputs: { report: ok } }` } });
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== alone.id);
    const batch = batchAt(store, "dev")!;
    const [fine, blocked] = batch.jobs.map((job) => job.id) as [string, string];
    await runtime.startStep(batch.managerAgentId, batch.id, "dev", "");
    await expect(runtime.completeStep(batch.managerAgentId, batch.id, "dev", { outcome: "success", outputs: { job_results: `${blocked}: { outcome: blocked }` } })).rejects.toThrow(/needs a reason/);
    await expect(runtime.completeStep(batch.managerAgentId, batch.id, "dev", { outcome: "success", outputs: { job_results: `${blocked}: { outcome: done, blocker: x }` } })).rejects.toThrow(/blocker only goes with an outcome that requeues/);
    await runtime.completeStep(batch.managerAgentId, batch.id, "dev", {
      outcome: "success",
      outputs: { job_results: `${fine}: { outputs: { report: ok } }\n${blocked}:\n  outcome: blocked\n  reason: blocker PR not queued\n  blocker: https://example.test/pull/9` },
    });
    await until(() => store.get(batch.id)!.status === "completed");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== batch.id);
    expect(batchAt(store, "dev")!.jobs.map((job) => job.id)).toEqual([blocked]);
    const pipeline = pipelineOf(store);
    const after = (id: string) => pipeline.jobs.find((job) => job.id === id)!;
    expect(after(fine)).toMatchObject({ status: "settled", outcome: "done" });
    expect(after(blocked)).toMatchObject({ status: "open", failedRides: {}, requeues: { dev: 1 }, requeued: null });
    expect(pipeline.history.find((entry) => entry.type === "job_requeued")!.detail).toMatch(/blocked: blocker PR not queued \(blocker: https:\/\/example.test\/pull\/9\)/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const event = (await runtime.bus.recent({ types: ["job.requeued"] })).events.find((candidate) => candidate.payload.cause === "outcome")!;
    expect(event.payload).toMatchObject({ jobId: blocked, stage: "dev", outcome: "blocked", reason: "blocker PR not queued", blocker: "https://example.test/pull/9", requeues: 1 });
  });

  it("settle_job with an outcome the playbook declares requeue puts the job back in its stage's queue", async () => {
    const release = APPLY.replace("outcomes: [done, rejected]", "outcomes: [done, rejected, blocked]").replace("    queue: { mode: merge }", "    queue: { mode: merge }\n    settle: { output: r }\n    outputs: { r: {} }").replace("gate: { question: Applied on dev? }", "role: { name: reviewer, prompt: x }");
    const { store, runtime } = await setup({ "apply.yaml": release.replace("settle: { output: r }", "settle: { output: r, effects: { blocked: requeue } }"), "pr.yaml": PR });
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    const id = dev.jobs[0]!.id;
    await runtime.settleJob(dev.managerAgentId, dev.id, id, { outcome: "blocked", summary: "waits", outputs: {}, blocker: "anything" });
    expect(store.get(dev.id)!.jobs[0]).toMatchObject({ status: "open", requeued: { stage: "dev", outcome: "blocked", blocker: "anything" } });
    expect(engine.openJobs(store.get(dev.id)!)).toEqual([]);
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "open", failedRides: {} });
  });

  it("end a job early with an outcome: it ends on the pipeline only, the batch goes on", async () => {
    const { store, runtime } = await setup();
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    await expect(runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { outcome: "maybe", summary: "", outputs: {} })).rejects.toThrow(/not an outcome of "apply"/);
    await expect(runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { outcome: "done", summary: "", outputs: {} })).rejects.toThrow(/missing output "report"/);
    await runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { outcome: "rejected", summary: "broke dev", outputs: {} });
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "settled", outcome: "rejected" });
    expect(store.get(pr.id)!.status).toBe("completed");
    expect(store.get(dev.id)!.status).toBe("running");
  });

  it("put a failed batch's jobs back at the front of its stage, within its retries, then fail them", async () => {
    const { store, runtime } = await setup();
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const first = await decide(runtime, store, "dev", "rejected");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== first.id);
    expect(pipelineOf(store).jobs[0]!.failedRides).toEqual({ dev: 1 });
    await decide(runtime, store, "dev", "rejected");
    await until(() => pipelineOf(store).jobs[0]!.status === "failed");
    expect(store.get(pr.id)!.status).toBe("completed");
  });

  it("fail the open jobs and cancel the batches when the pipeline is canceled", async () => {
    const { store, runtime } = await setup();
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    await runtime.cancelRun(pipelineOf(store).id, "stop", null);
    await until(() => store.get(dev.id)!.status === "canceled");
    expect(pipelineOf(store).jobs[0]!.status).toBe("failed");
    expect(store.get(pr.id)!.status).toBe("completed");
  });

  it("start a singleton by hand: its pipeline and workspace exist, with no batch", async () => {
    const { store, runtime, created } = await setup();
    const run = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "apply", {});
    expect(created).toHaveLength(1);
    expect(run).toMatchObject({ status: "running", managerAgentId: "", jobs: [] });
    expect(store.list().filter((candidate) => candidate.batch)).toHaveLength(0);
  });
});

describe("event core: job events of a pipeline", () => {
  // `job.boarded` is the deprecated twin of `job.joined` (ADR 2026-11-12-stage-batch-rename): the order tests leave it out.
  const allJobEvents = async (runtime: Runtime) => (await runtime.bus.recent({ types: ["job.*"] })).events;
  const jobEvents = async (runtime: Runtime) => (await allJobEvents(runtime)).filter((event) => event.type !== "job.boarded");
  const summary = (events: Awaited<ReturnType<typeof jobEvents>>) => events.map((event) => `${event.type}${event.payload.stage ? `@${String(event.payload.stage)}` : ""}`);

  it("announces a job's whole ride on the bus and keeps a log that rebuilds the pipeline's jobs", async () => {
    const { store, runtime } = await setup();
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    await runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { summary: "", outputs: { report: "dev ok" } });
    await decide(runtime, store, "dev", "approved");
    await until(() => batchAt(store, "prd") !== undefined);
    await decide(runtime, store, "prd", "approved");
    await until(() => store.get(pr.id)!.status === "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = await jobEvents(runtime);
    expect(summary(events)).toEqual(["job.queued@dev", "job.joined@dev", "job.advanced@dev", "job.queued@prd", "job.joined@prd", "job.advanced@prd", "job.settled@prd"]);
    const batches = store.list().filter((run) => run.batch).map((run) => run.id);
    expect(events[1]!.payload).toMatchObject({ runId: pipelineOf(store).id, playbook: "apply", jobId: pipelineOf(store).jobs[0]!.id, stage: "dev", outcome: null });
    expect(batches).toContain(events[1]!.payload.batchRunId);
    expect(events[2]!.payload).toMatchObject({ nextStages: ["prd"] });
    expect(events[3]!.payload).toMatchObject({ via: "advanced", batchRunId: null });
    expect(events.at(-1)!.payload).toMatchObject({ outcome: "done", stage: "prd" });
    // The log rebuilds the jobs (parity throws on every mutation in tests; this is the whole-log check).
    const pipeline = pipelineOf(store);
    const { events: logged } = await store.log.read(pipeline.id);
    expect(logged.map((event) => event.type).slice(0, 3)).toEqual(["jobs.genesis", "job.queued", "job.joined"]);
    expect(logged.at(-1)!.seq).toBe(pipeline.eventSeq);
    expect(verifyLog(EVENT_AREAS, pipeline, logged)).toEqual([]);
  });

  it("sends the deprecated names next to the new ones: job.boarded with job.joined, station and trainRunId with stage and batchRunId", async () => {
    const { store, runtime } = await setup();
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = await allJobEvents(runtime);
    const joined = events.find((event) => event.type === "job.joined")!;
    const boarded = events.find((event) => event.type === "job.boarded")!;
    expect(joined.payload).toMatchObject({ stage: "dev", station: "dev", batchRunId: batchAt(store, "dev")!.id, trainRunId: batchAt(store, "dev")!.id });
    expect(boarded.payload).toEqual(joined.payload);
    // An old subscription (type and filter with the old names) still matches the same event.
    expect(matchesFilter(["job.boarded"], { station: "dev" }, boarded)).toBe(true);
    expect(matchesFilter(["job.joined"], { stage: "dev" }, joined)).toBe(true);
    expect(() => checkTypes(JOB_TYPES, ["job.boarded"], { station: "dev", trainRunId: "x" })).not.toThrow();
  });

  it("announces a requeue and a failure", async () => {
    const { store, runtime } = await setup();
    const one = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const first = await decide(runtime, store, "dev", "rejected");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== first.id);
    await decide(runtime, store, "dev", "rejected");
    await until(() => pipelineOf(store).jobs[0]!.status === "failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = await jobEvents(runtime);
    expect(summary(events)).toEqual(["job.queued@dev", "job.joined@dev", "job.requeued@dev", "job.joined@dev", "job.failed@dev"]);
    expect(events[2]!.payload).toMatchObject({ rides: 1, retries: 1 });
    expect(String(events.at(-1)!.payload.reason)).toMatch(/batch .* at "dev" failed|rejected/);
    // The run that handed the job off is done already: nothing it does later touches the job.
    await runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "pr", { pr_url: "2" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(summary((await jobEvents(runtime)).slice(5))).toEqual(["job.queued@dev", "job.joined@dev"]);
    const pipeline = pipelineOf(store);
    expect(verifyLog(EVENT_AREAS, pipeline, (await store.log.read(pipeline.id)).events)).toEqual([]);
  });

  it("can be replayed with list_events by filter on stage", async () => {
    const { store, runtime } = await setup();
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const sub = await runtime.bus.subscribe("watcher", { kind: "agent", target: "watcher" }, ["job.*"], { stage: "dev" }).catch((error: Error) => error);
    expect(sub).not.toBeInstanceOf(Error);
  });
});

describe("requeue_job: a failed job goes back on the pipeline", () => {
  const FILES = { "apply.yaml": APPLY, "pr.yaml": PR, "forget.yaml": FORGET };
  /** Fails the stage's batch twice (one retry): the job fails on the pipeline. */
  async function failTwice(store: RunStore, runtime: Runtime) {
    await until(() => batchAt(store, "dev") !== undefined);
    const first = await decide(runtime, store, "dev", "rejected");
    await until(() => batchAt(store, "dev") !== undefined && batchAt(store, "dev")!.id !== first.id);
    const second = await decide(runtime, store, "dev", "rejected");
    await until(() => pipelineOf(store).jobs[0]!.status === "failed" && batchAt(store, "dev") === undefined);
    return second;
  }

  it("keeps the id and inputs, resets the rides, is carried by a new batch, and is idempotent", async () => {
    const { store, runtime } = await setup(FILES);
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "forget", { pr_url: "7" });
    const lost = await failTwice(store, runtime);
    const id = pipelineOf(store).jobs[0]!.id;
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "failed", detached: true, failedRides: { dev: 2 } });
    // Through a batch of the pipeline, as a manager or coordinator would hold it.
    const result = await runtime.requeueJob(lost.id, id, "manager lost");
    expect(result.changed).toBe(true);
    await until(() => batchAt(store, "dev") !== undefined);
    expect(pipelineOf(store).jobs).toHaveLength(1);
    expect(pipelineOf(store).jobs[0]).toMatchObject({ id, status: "open", inputs: { pr_url: "7" }, failedRides: {}, outcome: null, endedAt: null });
    expect(batchAt(store, "dev")!.jobs.map((job) => job.id)).toEqual([id]);
    // Open now: nothing changes.
    const again = await runtime.requeueJob(pipelineOf(store).id, id, "");
    expect(again.changed).toBe(false);
    expect(pipelineOf(store).jobs[0]!.batches).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = (await runtime.bus.recent({ types: ["job.*"] })).events.filter((event) => event.type !== "job.boarded");
    const names = events.map((event) => event.type);
    expect(names.slice(-3)).toEqual(["job.reopened", "job.queued", "job.joined"]);
    expect(events.find((event) => event.type === "job.reopened")!.payload).toMatchObject({ jobId: id, reason: "manager lost" });
    expect(events.at(-2)!.payload).toMatchObject({ via: "reopened", stage: "dev" });
    const pipeline = pipelineOf(store);
    expect(pipeline.history.some((entry) => entry.type === "job_reopened")).toBe(true);
    expect(verifyLog(EVENT_AREAS, pipeline, (await store.log.read(pipeline.id)).events)).toEqual([]);
  });

  it("refuses a settled job, an unknown job and a run that is no pipeline", async () => {
    const { store, runtime } = await setup(FILES);
    const pr = await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const id = pipelineOf(store).jobs[0]!.id;
    const dev = batchAt(store, "dev")!;
    await runtime.requestGate(dev.managerAgentId, dev.id, "dev", "ok?", "");
    await runtime.settleJob(dev.managerAgentId, dev.id, id, { outcome: "rejected", summary: "no", outputs: {} });
    await expect(runtime.requeueJob(pipelineOf(store).id, id, "")).rejects.toThrow(/is settled \(rejected\): only a failed job/);
    await expect(runtime.requeueJob(pipelineOf(store).id, "job_nope", "")).rejects.toThrow(/has no job "job_nope"/);
    await expect(runtime.requeueJob(pr.id, id, "")).rejects.toThrow(/not a singleton pipeline/);
    await expect(runtime.requeueJob("run_nope", id, "")).rejects.toThrow(/unknown run/);
  });
});

describe("detached jobs a batch ended: pending follow-ups and the empty-batch guard", () => {
  const SUB = `
title: Rel
hidden: true
steps:
  - id: a
    role: { name: reviewer, prompt: "{{ run.jobs }}" }
  - id: b
    needs: [a]
    role: { name: reviewer, prompt: "{{ run.jobs }}" }
`;
  const TRAIN = `
title: Train
singleton: {}
inputs:
  pr_url: { type: string, required: true }
outcomes: [done, ejected]
steps:
  - id: dev
    playbook: { name: rel }
`;
  const HAND = `
title: Hand
inputs:
  pr_url: { type: string, required: true }
steps:
  - id: go
    handoff: { name: train }
    inputs: { pr_url: ~ }
`;
  const FILES = { "rel.yaml": SUB, "train.yaml": TRAIN, "hand.yaml": HAND };

  async function ejected(setupResult: Awaited<ReturnType<typeof setup>>) {
    const { store, runtime } = setupResult;
    await runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "hand", { pr_url: "1" });
    await until(() => batchAt(store, "dev") !== undefined);
    const batch = batchAt(store, "dev")!;
    const jobId = batch.jobs[0]!.id;
    await runtime.startStep(batch.managerAgentId, batch.id, "dev.a", "");
    await runtime.settleJob(batch.managerAgentId, batch.id, jobId, { outcome: "ejected", summary: "provenance gap", outputs: {} });
    return { batch, jobId };
  }

  it("skips the steps not started once every job left the batch, with the reason in the history", async () => {
    const s = await setup(FILES);
    const { batch } = await ejected(s);
    await s.runtime.completeStep(batch.managerAgentId, batch.id, "dev.a", { outcome: "success", outputs: {} });
    const after = s.store.get(batch.id)!;
    expect(after.steps["dev.b"]!.status).toBe("skipped");
    expect(after.status).toBe("completed");
    expect(after.history.find((entry) => entry.type === "step_skipped" && entry.stepId === "dev.b")!.detail).toMatch(/no job left in this batch/);
  });

  it("flags a detached job that ended with an outcome until a follow-up is recorded, keeps the manager, and answers the query", async () => {
    const s = await setup(FILES);
    const { batch, jobId } = await ejected(s);
    await s.runtime.completeStep(batch.managerAgentId, batch.id, "dev.a", { outcome: "success", outputs: {} });
    await until(() => engine.pendingFollowUps(pipelineOf(s.store), s.store.get(batch.id)!).length === 1);
    expect(pipelineOf(s.store).history.some((entry) => entry.type === "job_followup_pending")).toBe(true);
    // The manager is reminded when its turn ends, and not archived.
    await s.runtime.onManagerTurnEnded(batch.managerAgentId);
    await until(() => s.sent.some((entry) => entry.agentId === batch.managerAgentId && /no follow-up is recorded/.test(entry.text)));
    expect(s.archived).not.toContain(batch.managerAgentId);
    // Nothing to record for a job that is not detached-and-ended; an unknown job is refused.
    await expect(s.runtime.recordFollowUp("job_nope", { runId: null, note: "x", by: null })).rejects.toThrow(/no pipeline has a job/);
    await expect(s.runtime.recordFollowUp(jobId, { runId: null, note: " ", by: null })).rejects.toThrow(/give a note/);
    s.runtime.checkFollowUp(jobId);
    const recorded = await s.runtime.recordFollowUp(jobId, { runId: "run_rework", note: null, by: batch.managerAgentId }, batch.id);
    expect(recorded.job.followUps).toMatchObject([{ runId: "run_rework", by: batch.managerAgentId }]);
    expect(engine.pendingFollowUps(pipelineOf(s.store), s.store.get(batch.id)!)).toEqual([]);
    // The batch's own copy shows it too; the query is the job's followUps.
    expect(s.store.get(batch.id)!.jobs[0]!.followUps).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = (await s.runtime.bus.recent({ types: ["job.followup", "job.followup_pending"] })).events;
    expect(events.map((event) => event.type)).toEqual(["job.followup_pending", "job.followup"]);
    expect(events[1]!.payload).toMatchObject({ jobId, followUpRunId: "run_rework", outcome: "ejected" });
    const pipeline = pipelineOf(s.store);
    expect(verifyLog(EVENT_AREAS, pipeline, (await s.store.log.read(pipeline.id)).events)).toEqual([]);
  });

  it("holds the retirement of a batch's manager while a follow-up is pending, and retires it once recorded", async () => {
    const s = await setup(FILES);
    const { batch, jobId } = await ejected(s);
    await s.runtime.completeStep(batch.managerAgentId, batch.id, "dev.a", { outcome: "success", outputs: {} });
    await until(() => engine.pendingFollowUps(pipelineOf(s.store), s.store.get(batch.id)!).length === 1);
    await s.runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "hand", { pr_url: "2" });
    await until(() => s.store.list().filter((run) => run.batch?.stage === "dev").length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.archived).not.toContain(batch.managerAgentId);
    await s.runtime.recordFollowUp(jobId, { runId: null, note: "rework not needed", by: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s.runtime.onManagerTurnEnded(batch.managerAgentId);
    await until(() => s.archived.includes(batch.managerAgentId));
  });
});
