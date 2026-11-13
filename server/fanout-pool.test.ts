import { chmod, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseList, renderTemplate } from "../shared/vars";
import { FanoutChildSchema, summarizeRun } from "../shared/types";
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

/** Just enough of the daemon API: idle agents, a workspace per `workspaces.create`, a manager per workspace. */
function fakePaseo(dir: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ title: string; source: unknown }> = [];
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
  const paseo = {
    agents: { ref },
    workspaces: {
      ref: (id: string) => ({ refresh: async () => workspace(id), agents: { create: createAgent }, archive: async () => undefined }),
      create: async (input: { title: string; source: unknown }) => {
        created.push(input);
        return { id: `wt${created.length}`, agents: { create: createAgent } };
      },
    },
  };
  return { paseo, sent, created };
}

const PLAN_SH = `#!/bin/sh
echo '{"summary": "planned", "outputs": {"ready": ["a", "b"], "base": "main"}}'
`;

const CHILD = `
title: Child
inputs:
  item: { type: string, required: true }
  base: { type: string }
outputs:
  result: { type: string, value: "{{ steps.work.outputs.result }}" }
steps:
  - id: work
    role: { name: implementer }
    outputs: { result: {} }
`;

function parent(spawn: string): string {
  return `
title: Parent
steps:
  - id: plan
    script: { run: plan.sh }
    outputs: { ready: { type: list }, base: {} }
  - id: spawn
    needs: [plan]
    inputs: [ready, base]
${spawn}
  - id: after
    needs: [spawn]
    role: { name: implementer }
`;
}

async function setup(files: Record<string, string>, pollMs = 40) {
  const dir = await mkdtemp(path.join(tmpdir(), "fanout-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "scripts", "plan.sh"), PLAN_SH);
  await chmod(path.join(root, "scripts", "plan.sh"), 0o755);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const boot = async () => {
    const runtime = new Runtime(store, { autoStartAgents: false, pollMs });
    runtimes.push(runtime);
    await runtime.attach(fake.paseo as never);
    return runtime;
  };
  return { dir, store, boot, runtime: await boot(), ...fake };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function errorsOf(files: Record<string, string>, id = "parent"): Promise<string> {
  const { dir } = await setup(files);
  return ((await loadPlaybooks(dir)).entries.find((entry) => entry.id === id)?.errors ?? []).join("\n");
}

async function startParent(ctx: Ctx, name = "parent") {
  const loaded = (await loadPlaybooks(ctx.dir)).entries.find((entry) => entry.id === name)!;
  expect(loaded.errors).toEqual([]);
  return ctx.runtime.startPlaybook({ id: "mgr0", workspaceId: "ws0", cwd: ctx.dir }, name, {}, { playbook: loaded.playbook! });
}

/** The child's manager creates its run, as it does with start_playbook. */
async function createChild(ctx: Ctx, n: number, item: string) {
  return ctx.runtime.startPlaybook({ id: `mgr${n}`, workspaceId: `wt${n}`, cwd: ctx.dir }, "child", { item, base: "main" });
}
const end = (ctx: Ctx, runId: string, status: "completed" | "failed", outputs: Record<string, string> = {}) =>
  ctx.store.mutate(runId, (run) => {
    run.status = status;
    run.outputs = status === "completed" ? outputs : null;
    run.failure = status === "failed" ? "boom" : null;
  });

const REFILL = `
title: Refill
inputs:
  done: { type: string }
outputs:
  items: { type: list, value: "{{ steps.pick.outputs.items }}" }
steps:
  - id: pick
    role: { name: implementer }
    outputs: { items: { type: list } }
`;

const POOL = (extra = "", refill = "") => `    fanout:
      playbook: child
      items: "{{ inputs.ready }}"
      inputs: { item: "{{ item }}", base: "{{ inputs.base }}" }
      workspace_name: "Work on {{ item }}"
      max_active: 2
      pool:
        refill:
          playbook: refill
          inputs: { done: "{{ pool.done }}" }
          max_refills: 5${refill}${extra}
    on: { some_failed: complete }`;

const FILES = (spawn = POOL()) => ({ "parent.yaml": parent(spawn), "child.yaml": CHILD, "refill.yaml": REFILL });
const stepOf = (ctx: Ctx, runId: string, stepId = "spawn") => ctx.store.get(runId)!.steps[stepId]!;
const pool = (ctx: Ctx, runId: string) => stepOf(ctx, runId).fanout!.pool!;
const kids = (ctx: Ctx, runId: string) => stepOf(ctx, runId).fanout!.children;
const kid = (ctx: Ctx, runId: string, key: string) => kids(ctx, runId).find((child) => child.key === key)!;

/** The manager of a refill pass's workspace creates its run. */
async function createPass(ctx: Ctx, n: number, done = "") {
  return ctx.runtime.startPlaybook({ id: `mgr${n}`, workspaceId: `wt${n}`, cwd: ctx.dir }, "refill", done ? { done } : {});
}
const endPass = (ctx: Ctx, runId: string, items: string[]) => end(ctx, runId, "completed", { items: JSON.stringify(items) });

/** a and b started; b is running, a ended. */
async function twoStarted() {
  const ctx = await setup(FILES());
  const run = await startParent(ctx);
  await until(() => ctx.created.length === 2);
  const a = await createChild(ctx, 1, "a");
  const b = await createChild(ctx, 2, "b");
  await until(() => kids(ctx, run.id).every((child) => child.status === "running"));
  return { ctx, run, a, b };
}

describe("work pool loading", () => {
  it("loads a pool with its outcome, outputs and defaults", async () => {
    const { dir } = await setup(FILES());
    const loaded = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "parent")!;
    expect(loaded.errors).toEqual([]);
    const step = loaded.playbook!.steps.find((candidate) => candidate.id === "spawn")!;
    expect(step.outcomes).toEqual(["all_completed", "some_failed", "failure", "refill_stopped"]);
    expect(Object.keys(step.outputs)).toContain("refills");
    expect(step.fanout!.pool).toMatchObject({ playbook: "refill", itemsOutput: "items", after: "completed", maxRefills: 5, debounceMs: 0 });
    expect(step.timeoutMs).toBe(12 * 3600 * 1000);
  });

  it("refuses a pool whose refill playbook is missing, recursive, lacks the items output or receives no finished keys", async () => {
    const bad = (spawn: string, refill = REFILL) => errorsOf({ ...FILES(spawn), "refill.yaml": refill });
    expect(await bad(POOL().replace("playbook: refill", "playbook: nope"))).toMatch(/fanout.pool.refill.playbook: playbook "nope" not found/);
    expect(await bad(POOL().replace("playbook: refill", "playbook: parent"))).toMatch(/must not start its own playbook/);
    expect(await bad(POOL(), REFILL.replace("items: {", "other: {"))).toMatch(/has no output "items"/);
    expect(await bad(POOL().replace('"{{ pool.done }}"', '"x"'))).toMatch(/no input receives the finished keys/);
    expect(await bad(POOL().replace("{{ pool.done }}", "{{ pool.nope }}"))).toMatch(/may use pool.done/);
    expect(await bad(POOL().replace("done:", "nothing:"))).toMatch(/has no input "nothing"/);
    expect(await bad(POOL().replace("max_refills: 5", "max_refills: 0"))).toMatch(/max_refills/);
    expect(await bad(POOL().replace("max_refills: 5", "max_refills: 5\n          debounce: soon"))).toMatch(/debounce: expected a duration/);
    expect(await bad(POOL().replace("      pool:", "      pool:\n        extra: 1"))).toMatch(/extra/);
    expect(await bad(POOL().replace("some_failed", "refill_stopped"))).toBe("");
    expect(await bad(POOL("", "").replace(/      pool:[\s\S]*?max_refills: 5/, "").replace("some_failed", "refill_stopped"))).toMatch(/not an outcome of a fan-out step/);
  });
});

describe("work pool runs", () => {
  it("starts a ticket unlocked by an early finisher while a slow sibling still runs, ignoring items already present", async () => {
    const { ctx, run, a, b } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    expect(ctx.created[2]!.title).toBe("Refill #1");
    const pass1 = await createPass(ctx, 3, '["a"]');
    expect(pass1.parent).toEqual({ runId: run.id, stepId: "spawn", key: "refill:1" });
    expect(ctx.store.get(pass1.id)!.inputs.done).toBe('["a"]');
    await until(() => pool(ctx, run.id).passes[0]!.status === "running");
    await endPass(ctx, pass1.id, ["a", "d"]);
    await until(() => ctx.created.length === 4);
    expect(ctx.created[3]!.title).toBe("Work on d");
    // b is still running: the fan-out did not wait for it.
    expect(kid(ctx, run.id, "b").status).toBe("running");
    expect(kids(ctx, run.id).map((child) => child.key)).toEqual(["a", "b", "d"]);
    expect(pool(ctx, run.id)).toMatchObject({ refills: 1, added: 1, status: "open" });
    expect(pool(ctx, run.id).passes[0]).toMatchObject({ n: 1, status: "completed", keys: ["a"], added: ["d"], skipped: 1, output: '["a","d"]' });
    expect(ctx.store.get(run.id)!.history.map((entry) => entry.type)).toEqual(expect.arrayContaining(["fanout_refill_started", "fanout_refill_ended"]));
    expect(summarizeRun(ctx.store.get(run.id)!).fanouts.spawn!.pool).toMatchObject({ refills: 1, added: 1, status: "open", passes: [{ n: 1, added: ["d"] }] });
    expect(b.id).toBeDefined();
  });

  it("coalesces completions during a pass into exactly one follow-up pass, and ends when nothing runs and nothing is added", async () => {
    const { ctx, run, a, b } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const pass1 = await createPass(ctx, 3, '["a"]');
    await until(() => pool(ctx, run.id).passes[0]!.status === "running");
    // A completion while the pass runs: no second pass yet.
    await end(ctx, b.id, "completed", { result: "rb" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pool(ctx, run.id).passes).toHaveLength(1);
    expect(ctx.created).toHaveLength(3);
    await endPass(ctx, pass1.id, ["d"]);
    // Pass 1 added d; b's ending makes exactly one follow-up pass due, started in the same tick as d.
    await until(() => ctx.created.length === 5);
    const at = (title: string) => ctx.created.findIndex((workspace) => workspace.title === title) + 1;
    expect(pool(ctx, run.id).passes).toHaveLength(2);
    expect(pool(ctx, run.id).passes[1]!.keys.sort()).toEqual(["a", "b"]);
    const d = await createChild(ctx, at("Work on d"), "d");
    const pass2 = await createPass(ctx, at("Refill #2"), '["a","b"]');
    // d ends while pass 2 runs (a second completion during a pass): it waits for pass 2, then one more pass follows.
    await end(ctx, d.id, "completed", { result: "rd" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pool(ctx, run.id).passes).toHaveLength(2);
    await endPass(ctx, pass2.id, ["d"]);
    await until(() => pool(ctx, run.id).passes.length === 3);
    expect(pool(ctx, run.id).passes[2]!.keys.sort()).toEqual(["a", "b", "d"]);
    await until(() => ctx.created.length === 6);
    await endPass(ctx, (await createPass(ctx, at("Refill #3"), '["a","b","d"]')).id, []);
    await until(() => stepOf(ctx, run.id).status === "completed");
    expect(stepOf(ctx, run.id).attempts.at(-1)!.outcome).toBe("all_completed");
    expect(stepOf(ctx, run.id).outputs).toMatchObject({ total: 3, completed: 3, refills: 3, added: 1 });
    expect(pool(ctx, run.id).passes.map((pass) => pass.added)).toEqual([["d"], [], []]);
  });

  it("queues items beyond max_active and starts them as slots free up", async () => {
    const { ctx, run, a } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const pass = await createPass(ctx, 3, '["a"]');
    await endPass(ctx, pass.id, ["c", "d", "e"]);
    await until(() => ctx.created.length === 4);
    // b + c active (cap 2); d and e wait, queued.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.created).toHaveLength(4);
    expect(kids(ctx, run.id).filter((child) => child.status === "pending").map((child) => child.key)).toEqual(["d", "e"]);
    expect(engine.fanoutCounts(stepOf(ctx, run.id).fanout!)).toMatchObject({ active: 2, pending: 2 });
  });

  it("stops refilling when a pass fails: running children go on, then the step ends refill_stopped", async () => {
    const { ctx, run, a, b } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const pass = await createPass(ctx, 3, '["a"]');
    await end(ctx, pass.id, "failed");
    await until(() => pool(ctx, run.id).status === "stopped");
    expect(pool(ctx, run.id).stopReason).toMatch(/refill #1 failed/);
    expect(ctx.store.get(b.id)!.status).not.toBe("canceled");
    expect(stepOf(ctx, run.id).status).toBe("running");
    await end(ctx, b.id, "completed", { result: "rb" });
    await until(() => stepOf(ctx, run.id).attempts.at(-1)?.outcome === "refill_stopped");
    expect(stepOf(ctx, run.id).attempts.at(-1)!.outcome).toBe("refill_stopped");
    expect(ctx.created).toHaveLength(3);
  });

  it("fails the pass on an unusable list or clashing keys, never adding children", async () => {
    const { ctx, run, a } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const pass = await createPass(ctx, 3, '["a"]');
    await endPass(ctx, pass.id, ["x", "x"]);
    await until(() => pool(ctx, run.id).status === "stopped");
    expect(pool(ctx, run.id).passes[0]!.error).toMatch(/same key "x"/);
    expect(kids(ctx, run.id).map((child) => child.key)).toEqual(["a", "b"]);
  });

  it("stops at max_refills with children still finishing", async () => {
    const ctx = await setup(FILES(POOL().replace("max_refills: 5", "max_refills: 1")));
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    const a = await createChild(ctx, 1, "a");
    const b = await createChild(ctx, 2, "b");
    await until(() => kids(ctx, run.id).every((child) => child.status === "running"));
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    await endPass(ctx, (await createPass(ctx, 3, '["a"]')).id, []);
    await end(ctx, b.id, "completed", { result: "rb" });
    await until(() => stepOf(ctx, run.id).attempts.at(-1)?.outcome === "refill_stopped");
    expect(stepOf(ctx, run.id).attempts.at(-1)!.outcome).toBe("refill_stopped");
    expect(pool(ctx, run.id).stopReason).toMatch(/max_refills \(1\)/);
    expect(ctx.created).toHaveLength(3);
  });

  it("with `after: ended` a failed child also triggers a pass; with the default it does not", async () => {
    const { ctx, run, a } = await twoStarted();
    await end(ctx, a.id, "failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pool(ctx, run.id).passes).toHaveLength(0);
    const ended = await setup(FILES(POOL("", "\n          after: ended")));
    const run2 = await startParent(ended);
    await until(() => ended.created.length === 2);
    const a2 = await createChild(ended, 1, "a");
    await createChild(ended, 2, "b");
    await end(ended, a2.id, "failed");
    await until(() => ended.created.length === 3);
    expect(pool(ended, run2.id).passes[0]!.keys).toEqual(["a"]);
    expect(run.id).toBeDefined();
  });

  it("a restart while a pass runs follows it; a pass whose creation was cut is run again", async () => {
    const { ctx, run, a } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    // The pass is still `starting` when the daemon restarts: its reservation is gone.
    await ctx.runtime.dispose();
    // Let the old process's tick in flight finish (a real restart has none).
    await new Promise((resolve) => setTimeout(resolve, 200));
    ctx.runtime = await ctx.boot();
    await until(() => pool(ctx, run.id).passes.some((pass) => pass.status === "lost"));
    await until(() => ctx.created.length === 4);
    expect(pool(ctx, run.id).refills).toBe(1);
    const pass = await createPass(ctx, 4, '["a"]');
    await until(() => pool(ctx, run.id).passes.at(-1)!.status === "running");
    // A restart with the pass running: the new daemon follows its run and applies its items.
    await ctx.runtime.dispose();
    ctx.runtime = await ctx.boot();
    await endPass(ctx, pass.id, ["e"]);
    await until(() => kids(ctx, run.id).some((child) => child.key === "e"));
    expect(pool(ctx, run.id).passes.map((entry) => entry.status)).toEqual(["lost", "completed"]);
    expect(pool(ctx, run.id)).toMatchObject({ refills: 1, added: 1 });
  });

  it("replace_child during a pass keeps the item open; its next ending triggers a new pass", async () => {
    const { ctx, run, a, b } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const pass = await createPass(ctx, 3, '["a"]');
    await until(() => pool(ctx, run.id).passes[0]!.status === "running");
    await ctx.runtime.cancelRun(b.id, "restarting", "by agent mgr2");
    const b2 = await ctx.runtime.startPlaybook({ id: "mgr9", workspaceId: "wt9", cwd: ctx.dir }, "child", { item: "b", base: "main" });
    await ctx.runtime.replaceChild({ runId: b.id, newRunId: b2.id, reason: "restart", by: "mgr2", cancelBy: null });
    await endPass(ctx, pass.id, []);
    await until(() => pool(ctx, run.id).passes[0]!.status === "completed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    // b was replaced, never "done": no pass, and the step waits for b2.
    expect(pool(ctx, run.id).passes).toHaveLength(1);
    expect(stepOf(ctx, run.id).status).toBe("running");
    await end(ctx, b2.id, "completed", { result: "rb" });
    await until(() => ctx.created.length === 4);
    expect(pool(ctx, run.id).passes[1]!.keys.sort()).toEqual(["a", "b"]);
  });

  it("cancels an in-flight pass with the run", async () => {
    const { ctx, run, a } = await twoStarted();
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const pass = await createPass(ctx, 3, '["a"]');
    await until(() => pool(ctx, run.id).passes[0]!.status === "running");
    await ctx.runtime.cancelRun(run.id, "stop", "by test");
    await until(() => ctx.store.get(pass.id)!.status === "canceled");
  });

  it("emits fanout.refill with the added keys", async () => {
    const { ctx, run, a } = await twoStarted();
    const events: Array<Record<string, unknown>> = [];
    const emit = (ctx.runtime as unknown as { bus: { emit: (type: string, payload: Record<string, unknown>) => Promise<unknown> } }).bus;
    const original = emit.emit.bind(emit);
    emit.emit = async (type, payload, ...rest) => {
      if (type === "fanout.refill") events.push(payload);
      return (original as (...args: unknown[]) => Promise<unknown>)(type, payload, ...rest);
    };
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    await endPass(ctx, (await createPass(ctx, 3, '["a"]')).id, ["d"]);
    await until(() => events.some((event) => event.phase === "ended"));
    expect(events.map((event) => event.phase)).toEqual(["started", "ended"]);
    expect(events[1]).toMatchObject({ runId: run.id, n: 1, status: "completed", added: ["d"], doneKeys: ["a"] });
  });
});

describe("work pool engine", () => {
  it("is due only with an unhandled trigger, the cap left, no pass running and the debounce passed", () => {
    const base = Date.parse("2026-01-01T00:00:10Z");
    const child = (key: string, status: engine.FanoutChildStatus) => ({ key, index: 0, item: "1", inputs: {}, workspaceName: "", status, runId: null, workspaceId: null, error: null, startedAt: null, endedAt: "2026-01-01T00:00:00Z", outputs: {}, previous: [] });
    const state = { attempt: 1, loop: 0, startedAt: "", children: [child("a", "completed"), child("b", "failed")], pool: { refills: 0, lastRefillAt: null, added: 0, handled: [] as string[], status: "open" as const, stopReason: null, passes: [] } };
    const config = { playbook: "p", inputs: {}, itemsOutput: "items", after: "completed" as const, maxRefills: 2, debounceMs: 5000 };
    expect(engine.poolTriggers(state, config).map((entry) => entry.key)).toEqual(["a"]);
    expect(engine.poolPassDue(state, config, base)).toBe(true);
    expect(engine.poolPassDue(state, { ...config, debounceMs: 20_000 }, base)).toBe(false);
    expect(engine.poolPassDue(state, { ...config, after: "ended" }, base)).toBe(true);
    state.pool.handled = ["a"];
    expect(engine.poolPassDue(state, config, base)).toBe(false);
    expect(engine.fanoutJoined(state, config)).toBe(true);
    state.pool.handled = [];
    expect(engine.fanoutJoined(state, config)).toBe(false);
    expect(engine.fanoutJoined(state)).toBe(true);
  });
});
