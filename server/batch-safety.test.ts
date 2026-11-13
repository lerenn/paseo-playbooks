import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
    const id = `agent${++agents}`;
    return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
  };
  const workspace = (id: string) => ({ id, projectId: "p", workspaceDirectory: dir });
  const paseo = {
    agents: { ref },
    workspaces: {
      ref: (id: string) => ({ refresh: async () => workspace(id), agents: { create: createAgent }, archive: async () => undefined }),
      create: async () => ({ id: "wt1", agents: { create: createAgent } }),
    },
  };
  return { paseo, sent };
}

// Two stages, each one reviewer step that settles jobs; `pin` is required to leave the pipeline.
const RELEASE = `
title: Release
singleton: { branch: main }
inputs:
  pr_url: { type: string, required: true }
  services: { type: string, required: true }
outputs:
  pin: { type: string }
outcomes: [shipped, no_deploy]
steps:
  - id: dev
    role: { name: reviewer, prompt: "{{ run.jobs }}" }
    outputs: { job_results: {} }
    outcomes: [success, asking]
    settle: { output: job_results }
    on:
      asking: { ask: "Which database?", max_loops: 2 }
  - id: prd
    needs: [dev]
    role: { name: reviewer, prompt: "{{ run.jobs }}" }
    outputs: { job_results: {} }
    settle: { output: job_results }
`;
const GATES = `
title: Release
singleton: { branch: main }
inputs:
  pr_url: { type: string, required: true }
  services: { type: string, required: true }
outputs:
  pin: { type: string }
outcomes: [shipped, no_deploy]
steps:
  - id: dev
    gate: { question: ok? }
  - id: prd
    needs: [dev]
    gate: { question: ok? }
    retries: 1
`;
const PR = `
title: PR
inputs:
  pr_url: { type: string, required: true }
  services: { type: string, required: true }
steps:
  - id: release
    handoff: { name: release }
    inputs: { pr_url: ~, services: ~ }
    retries: 1
`;

async function setup(release: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "batch-safety-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "release.yaml"), release);
  await writeFile(path.join(root, "pr.yaml"), PR);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { store, runtime };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const now = () => new Date().toISOString();
const batchAt = (store: RunStore, stage: string) =>
  store.list().find((run) => run.batch?.stage === stage && (run.status === "running" || run.status === "waiting_gate"));
const pipelineOf = (store: RunStore) => store.list().find((run) => run.playbook.singleton && run.batch === null)!;

async function hand(runtime: Runtime, services = "pg-migrations") {
  return runtime.startPlaybook({ id: "m1", workspaceId: "ws1", cwd: "/" }, "pr", { pr_url: "1", services });
}

describe("batch safety", () => {
  it("keeps the settle output of the report against a manager's empty value, and checks outputs before the batch completes", async () => {
    const { store, runtime } = await setup(RELEASE);
    await hand(runtime);
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    const job = dev.jobs[0]!.id;
    const { agentId } = await runtime.startStep(dev.managerAgentId, dev.id, "dev", "");
    await runtime.report(agentId, { outcome: "success", summary: "ok", outputs: { job_results: `${job}: { outputs: { pin: abc } }` } });
    await runtime.onStepTurnEnded(dev.id, agentId, "completed");
    await expect(runtime.completeStep(dev.managerAgentId, dev.id, "dev", { outcome: "success", outputs: { job_results: "{}" } })).rejects.toThrow(/never empty them/);
    expect(store.get(dev.id)!.steps.dev!.status).toBe("reported");
    await runtime.completeStep(dev.managerAgentId, dev.id, "dev", { outcome: "success" });
    expect(pipelineOf(store).jobs[0]!.outputs).toEqual({ pin: "abc" });

    // At the last stage, a report that sets nothing for a job without `pin`: the batch would end it without its output.
    await until(() => batchAt(store, "prd") !== undefined);
    const prd = batchAt(store, "prd")!;
    pipelineOf(store).jobs[0]!.outputs = {};
    await store.mutate(pipelineOf(store).id, (run) => void (run.jobs[0]!.outputs = {}));
    await store.mutate(prd.id, (run) => void (run.jobs[0]!.outputs = {}));
    const second = await runtime.startStep(prd.managerAgentId, prd.id, "prd", "");
    await runtime.report(second.agentId, { outcome: "success", summary: "ok", outputs: { job_results: "{}" } });
    await runtime.onStepTurnEnded(prd.id, second.agentId, "completed");
    await expect(runtime.completeStep(prd.managerAgentId, prd.id, "prd", { outcome: "success" })).rejects.toThrow(new RegExp(`${job}: missing output "pin"`));
    expect(store.get(prd.id)!.status).toBe("running");
  });

  it("does not hand a job off again when it passed every stage and only lacks an output", async () => {
    const { store, runtime } = await setup(GATES);
    const pr = await hand(runtime);
    for (const stage of ["dev", "prd"]) {
      await until(() => batchAt(store, stage) !== undefined);
      const batch = batchAt(store, stage)!;
      await runtime.requestGate(batch.managerAgentId, batch.id, stage, "ok?", "");
      await runtime.decideGate(batch.id, stage, { decision: "approved", comment: null, by: null, via: "panel", now: now() });
    }
    await until(() => pipelineOf(store).jobs[0]!.status === "failed");
    const pipeline = pipelineOf(store);
    expect(pipeline.jobs).toHaveLength(1);
    expect(pipeline.jobs[0]).toMatchObject({ status: "failed", passed: ["dev", "prd"] });
    expect(pipeline.jobs[0]!.summary).toMatch(/missing output "pin".*do not hand it off again/);
    expect(store.get(pr.id)!.steps.release!.attempts).toHaveLength(1);
  });

  it("opens the ask of a step that reports an ask outcome, and refuses nudge_step on it", async () => {
    const { store, runtime } = await setup(RELEASE);
    await hand(runtime);
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    const { agentId } = await runtime.startStep(dev.managerAgentId, dev.id, "dev", "");
    await runtime.report(agentId, { outcome: "asking", summary: "Which database?", outputs: {} });
    await runtime.onStepTurnEnded(dev.id, agentId, "completed");
    const batch = store.get(dev.id)!;
    expect(batch.gates).toMatchObject([{ kind: "ask", stepId: "dev", status: "pending" }]);
    expect(batch.steps.dev!.status).toBe("waiting");
    await expect(runtime.nudgeStep(dev.id, "dev", "the answer is pg")).rejects.toThrow(/resume/);
  });

  it("refuses no_deploy for a job whose services deploy, and an unknown outcome in a report", async () => {
    const { store, runtime } = await setup(RELEASE);
    await hand(runtime);
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    const job = dev.jobs[0]!.id;
    await expect(runtime.settleJob(dev.managerAgentId, dev.id, job, { outcome: "no_deploy", summary: "", outputs: {} })).rejects.toThrow(/only for a job whose services is none/);
    const { agentId } = await runtime.startStep(dev.managerAgentId, dev.id, "dev", "");
    await expect(runtime.report(agentId, { outcome: "success", summary: "", outputs: { job_results: `${job}: { outcome: success }` } })).rejects.toThrow(/"success", which is not an outcome of "release"/);
    await runtime.report(agentId, { outcome: "success", summary: "", outputs: { job_results: `${job}: { outputs: { pin: x } }` } });
  });

  it("accepts no_deploy for a job whose services is none", async () => {
    const { store, runtime } = await setup(RELEASE);
    await hand(runtime, "none");
    await until(() => batchAt(store, "dev") !== undefined);
    const dev = batchAt(store, "dev")!;
    await runtime.settleJob(dev.managerAgentId, dev.id, dev.jobs[0]!.id, { outcome: "no_deploy", summary: "docs", outputs: {} });
    expect(pipelineOf(store).jobs[0]).toMatchObject({ status: "settled", outcome: "no_deploy" });
  });
});
