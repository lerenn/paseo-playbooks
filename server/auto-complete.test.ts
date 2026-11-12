import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endTurn } from "./engine";
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

// qa applies success and merged itself; build applies success, but a gate follows it; last ends the run.
const PLAYBOOK = `
title: Auto
steps:
  - id: qa
    outcomes: [success, merged, needs_work, failure]
    on: { merged: complete, needs_work: fail }
    outputs: { note: {} }
    role: { name: implementer, completion: { auto: [success, merged] } }
  - id: build
    needs: [qa]
    role: { name: implementer, completion: { auto: [success] } }
  - id: approve
    needs: [build]
    gate: { question: Ship it? }
  - id: last
    needs: [approve]
    role: { name: implementer, completion: { auto: [success] } }
`;

function fakePaseo(dir: string) {
  const created: string[] = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => undefined,
    reload: async () => undefined,
  });
  const workspace = {
    id: "ws",
    projectId: "p",
    workspaceDirectory: dir,
    agents: {
      create: async () => {
        const id = `step-${created.length + 1}`;
        created.push(id);
        return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
      },
    },
  };
  const providers = { listModels: async (provider: string) => ({ provider, models: [{ id: "claude-haiku-5-5" }] }) };
  return { paseo: { agents: { ref }, workspaces: { ref: () => ({ ...workspace, refresh: async () => workspace }) }, providers }, created, sent };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "auto-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "auto.yaml"), PLAYBOOK);
  expect((await loadPlaybooks(dir)).entries.find((entry) => entry.id === "auto")!.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "auto", {});
  await runtime.autoStartReady("m", run.id);
  return { dir, store, runtime, run, ...fake };
}

const toManager = (sent: Array<{ agentId: string; text: string }>) => sent.filter((entry) => entry.agentId === "m");

/** The agent of the running step reports, then its turn ends. */
async function finish(runtime: Runtime, agentId: string, outcome: string, outputs: Record<string, unknown> = {}) {
  await runtime.report(agentId, { outcome, summary: `did ${outcome}`, outputs });
  await runtime.onStepTurnEnded(runtimeRun(runtime), agentId, "completed");
}
const runIds = new WeakMap<Runtime, string>();
const runtimeRun = (runtime: Runtime) => runIds.get(runtime)!;

describe("role.completion.auto", () => {
  it("applies a listed outcome without a manager turn, starts what follows and queues a quiet line", async () => {
    const { runtime, store, run, created, sent } = await setup();
    runIds.set(runtime, run.id);
    await runtime.subscribeEvents("watcher", ["step.*"], {}, "steer");
    await runtime.watchEvents();
    await finish(runtime, "step-1", "success", { note: "ok" });
    const after = store.get(run.id)!;
    expect(after.steps.qa!.status).toBe("completed");
    expect(after.steps.qa!.outputs).toEqual({ note: "ok" });
    expect(after.steps.build!.status).toBe("running");
    expect(created).toEqual(["step-1", "step-2"]);
    expect(toManager(sent)).toEqual([]);
    expect(after.inbox).toHaveLength(1);
    expect(after.inbox[0]).toMatch(/qa" attempt 1 reported success[\s\S]*plugin applied it[\s\S]*do not call complete_step[\s\S]*started: build/);
    await runtime.watchEvents();
    await runtime.watchEvents();
    const types = (await runtime.bus.recent()).events.filter((event) => event.type === "step.completed").map((event) => [event.payload.stepId, event.payload.outcome]);
    expect(types).toEqual([["qa", "success"]]);
  });

  it("applies another listed outcome", async () => {
    const { runtime, store, run } = await setup();
    runIds.set(runtime, run.id);
    await finish(runtime, "step-1", "merged", { note: "m" });
    expect(store.get(run.id)!.steps.qa!.status).toBe("completed");
  });

  it("wakes the manager for an outcome that is not listed, and for a failure", async () => {
    const { runtime, store, run, sent } = await setup();
    runIds.set(runtime, run.id);
    await finish(runtime, "step-1", "needs_work", { note: "x" });
    expect(store.get(run.id)!.steps.qa!.status).toBe("reported");
    expect(toManager(sent)).toHaveLength(1);
    expect(toManager(sent)[0]!.text).toMatch(/reported needs_work[\s\S]*Call complete_step for "qa"/);
  });

  it("wakes the manager for a failure", async () => {
    const { runtime, store, run, sent } = await setup();
    runIds.set(runtime, run.id);
    await finish(runtime, "step-1", "failure");
    expect(store.get(run.id)!.steps.qa!.status).toBe("reported");
    expect(toManager(sent)[0]!.text).toMatch(/reported failure/);
  });

  it("does not apply when a gate (or the run's end) would come next, and wakes the manager", async () => {
    const { runtime, store, run, sent } = await setup();
    runIds.set(runtime, run.id);
    await finish(runtime, "step-1", "success", { note: "ok" });
    expect(toManager(sent)).toEqual([]);
    await finish(runtime, "step-2", "success");
    const after = store.get(run.id)!;
    expect(after.steps.build!.status).toBe("reported");
    expect(after.steps.approve!.status).toBe("pending");
    expect(toManager(sent)).toHaveLength(1);
    // The quiet line rode along with the real wake-up.
    expect(toManager(sent)[0]!.text).toMatch(/qa" attempt 1 reported success[\s\S]*build" attempt 1 reported success[\s\S]*Call complete_step for "build"/);
  });

  it("refuses complete_step on a step the plugin already applied, and applies nothing twice", async () => {
    const { runtime, store, run, created } = await setup();
    runIds.set(runtime, run.id);
    await finish(runtime, "step-1", "success", { note: "ok" });
    await expect(runtime.completeStep("m", run.id, "qa", { outcome: "success" })).rejects.toThrow(/already been applied/);
    await runtime.onStepTurnEnded(run.id, "step-1", "completed");
    expect(created).toHaveLength(2);
    expect(store.get(run.id)!.history.filter((entry) => entry.type === "step_completed" && entry.stepId === "qa")).toHaveLength(1);
  });

  it("applies a report left unapplied by a restart once, and not again on the next restart", async () => {
    const { runtime, store, run, dir, created } = await setup();
    await runtime.report("step-1", { outcome: "success", summary: "ok", outputs: { note: "ok" } });
    await store.mutate(run.id, (current) => void endTurn(current, "step-1", { turnEnd: "completed", lastMessage: null, now: new Date().toISOString() }));
    expect(store.get(run.id)!.steps.qa!.status).toBe("reported");
    await runtime.dispose();
    for (let restart = 0; restart < 2; restart++) {
      const fake = fakePaseo(dir);
      fake.created.push(...created);
      const again = new Runtime(store);
      runtimes.push(again);
      await again.attach(fake.paseo as never);
      expect(store.get(run.id)!.steps.qa!.status).toBe("completed");
      expect(store.get(run.id)!.steps.build!.status).toBe("running");
      expect(store.get(run.id)!.history.filter((entry) => entry.type === "step_completed" && entry.stepId === "qa")).toHaveLength(1);
      expect(fake.created.length).toBe(restart === 0 ? 2 : 1);
      await again.dispose();
    }
  });
});
