import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "./engine";
import { loadPlaybooks } from "./loader";
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
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async () => undefined,
    reload: async () => undefined,
    archive: async () => undefined,
  });
  const createAgent = async () => ({ id: `mgr${++agents}`, send: async () => undefined });
  const workspace = (id: string) => ({ id, projectId: "p", workspaceDirectory: dir });
  return {
    agents: { ref },
    workspaces: {
      ref: (id: string) => ({ refresh: async () => workspace(id), agents: { create: createAgent }, archive: async () => undefined }),
      create: async () => ({ id: "wt", agents: { create: createAgent } }),
    },
  };
}

const CHILD = `
title: Child
inputs:
  item: { type: string, required: true }
steps:
  - id: work
    role: { name: implementer }
    outputs: { result: {} }
`;
const PARENT = `
title: Parent
steps:
  - id: plan
    role: { name: implementer }
    outputs: { ready: { type: list } }
  - id: spawn
    needs: [plan]
    inputs: [ready]
    fanout:
      playbook: child
      items: "{{ inputs.ready }}"
      inputs: { item: "{{ item }}" }
      max_active: 2
    on: { some_failed: complete }
`;

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** A run whose plan completed and whose fan-out is ready: the state a dropped start leaves. */
async function stuck(damage: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "parent.yaml"), PARENT);
  await writeFile(path.join(root, "child.yaml"), CHILD);
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "parent")!.playbook!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = engine.newRun({ id: "run_stuck", playbook, workspaceId: "ws0", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "mgr0", inputs: {}, now: new Date().toISOString() });
  run.steps.plan!.status = "completed";
  run.steps.plan!.outputs = { ready: '["a","b"]' };
  run.steps.spawn!.status = "ready";
  await store.create(run);
  if (damage) {
    // A pipeline-like run that lacks the state of its steps: it used to throw in every tick, before the fan-outs were reached.
    const other = structuredClone(run);
    other.id = "run_damaged";
    other.createdAt = "2000-01-01T00:00:00.000Z";
    delete (other.steps as Record<string, unknown>).spawn;
    await store.create(other);
  }
  const boot = async () => {
    const runtime = new Runtime(store, { pollMs: 40 });
    runtimes.push(runtime);
    await runtime.attach(fakePaseo(dir) as never);
    return runtime;
  };
  return { store, boot };
}

describe("a ready step the plugin starts itself, found not started", () => {
  it("is started once at plugin start, and logged step_recovered", async () => {
    const { store, boot } = await stuck(false);
    await boot();
    await until(() => store.get("run_stuck")!.steps.spawn!.status === "running");
    const children = store.get("run_stuck")!.steps.spawn!.fanout!.children;
    expect(children.map((child) => child.key).sort()).toEqual(["a", "b"]);
    expect(store.get("run_stuck")!.history.filter((entry) => entry.type === "step_recovered")).toHaveLength(1);
    // A second start of the plugin finds it running: nothing is started or logged again.
    await boot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(store.get("run_stuck")!.steps.spawn!.fanout!.children.map((child) => child.runId)).toEqual(children.map((child) => child.runId));
    expect(store.get("run_stuck")!.history.filter((entry) => entry.type === "step_recovered")).toHaveLength(1);
  });

  it("is not held back by another run that lacks step records (state added at load, ticks isolated)", async () => {
    const { store, boot } = await stuck(true);
    // The damaged run is repaired when the store loads: simulate the in-memory damage of a store that was not reloaded.
    await boot();
    await until(() => store.get("run_stuck")!.steps.spawn!.status === "running");
    expect(store.get("run_damaged")).toBeDefined();
  });

  it("accessors and repair tolerate a missing step record", async () => {
    const { store } = await stuck(true);
    const damaged = structuredClone(store.get("run_damaged")!);
    delete (damaged.steps as Record<string, unknown>).spawn;
    expect(() => engine.readySteps(damaged)).not.toThrow();
    expect(engine.readyFanouts(damaged)).toEqual([]);
    expect(engine.queuedSteps(damaged)).toEqual([]);
    expect(engine.repairRun(damaged)).toEqual(["spawn"]);
    expect(damaged.steps.spawn!.status).toBe("pending");
  });

  it("cancel_run works on a run whose step record is missing", async () => {
    const { store, boot } = await stuck(true);
    const runtime = await boot();
    await store.mutate("run_damaged", (run) => {
      delete (run.steps as Record<string, unknown>).plan;
    });
    await expect(runtime.cancelRun("run_damaged", "test", null)).resolves.toMatchObject({ status: "canceled" });
  });
});
