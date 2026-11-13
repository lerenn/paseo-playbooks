import { chmod, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseList, renderTemplate } from "../shared/vars";
import { summarizeRun } from "../shared/types";
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
echo '{"summary": "planned", "outputs": {"ready": ["a", "b", "c"], "base": "main"}}'
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

const SPAWN = `    fanout:
      playbook: child
      items: "{{ inputs.ready }}"
      inputs: { item: "{{ item }}", base: "{{ inputs.base }}" }
      workspace_name: "Work on {{ item }}"
      max_active: 2
    on: { some_failed: complete }`;

async function setup(files: Record<string, string> = { "parent.yaml": parent(SPAWN), "child.yaml": CHILD }, pollMs = 40) {
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
const stepOf = (ctx: Ctx, runId: string, stepId = "spawn") => ctx.store.get(runId)!.steps[stepId]!;

describe("list values", () => {
  it("parse a JSON array of scalars and flat objects, within bounds", () => {
    expect(parseList('["a", 2, true, {"id": "x", "n": 1}]')).toMatchObject({ ok: true, text: '["a",2,true,{"id":"x","n":1}]' });
    expect(parseList([1, 2])).toMatchObject({ ok: true });
    expect(parseList("not json")).toMatchObject({ ok: false });
    expect(parseList('{"a": 1}')).toMatchObject({ ok: false });
    expect(parseList('[[1]]')).toMatchObject({ ok: false, error: expect.stringMatching(/no nesting/) });
    expect(parseList('[{"a": {"b": 1}}]')).toMatchObject({ ok: false });
    expect(parseList(Array.from({ length: 201 }, (_, i) => i))).toMatchObject({ ok: false, error: expect.stringMatching(/at most 200/) });
    expect(parseList(["x".repeat(33_000)])).toMatchObject({ ok: false });
  });

  it("a script's array output is stored as JSON text and renders in templates", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => stepOf(ctx, run.id, "plan").status === "completed");
    const outputs = stepOf(ctx, run.id, "plan").outputs;
    expect(outputs.ready).toBe('["a","b","c"]');
    expect(renderTemplate("Ready: {{ steps.plan.outputs.ready }}", { steps: { plan: { outputs } } })).toBe('Ready: ["a","b","c"]');
  });
});

describe("fan-out loading", () => {
  it("loads with fixed outcomes and outputs", async () => {
    const { dir } = await setup();
    const loaded = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "parent")!;
    expect(loaded.errors).toEqual([]);
    const step = loaded.playbook!.steps.find((candidate) => candidate.id === "spawn")!;
    expect(step).toMatchObject({ kind: "fanout", outcomes: ["all_completed", "some_failed", "failure"], fanout: { playbook: "child", maxActive: 2, cancelChildren: true } });
    expect(Object.keys(step.outputs)).toEqual(["results", "total", "started", "completed", "failed", "canceled", "not_started", "any_failed"]);
    expect(step.outputs.results).toEqual({ type: "list" });
  });

  it("refuses unknown playbooks, recursion, missing and unknown child inputs, bad templates and misplaced options", async () => {
    const bad = (spawn: string) => errorsOf({ "parent.yaml": parent(spawn), "child.yaml": CHILD });
    expect(await bad(SPAWN.replace("playbook: child", "playbook: nope"))).toMatch(/fanout.playbook: playbook "nope" not found/);
    expect(await bad(SPAWN.replace("playbook: child", "playbook: parent"))).toMatch(/must not start its own playbook/);
    expect(await bad(SPAWN.replace('item: "{{ item }}", ', ""))).toMatch(/requires input "item"/);
    expect(await bad(SPAWN.replace("base:", "nope:"))).toMatch(/has no input "nope"/);
    expect(await bad(SPAWN.replace("{{ inputs.ready }}", "{{ steps.plan.outputs.ready }}"))).toMatch(/fanout.items uses "\{\{ steps.plan.outputs.ready \}\}"/);
    expect(await bad(SPAWN.replace("{{ inputs.ready }}", "x {{ inputs.ready }}"))).toMatch(/exactly one reference/);
    expect(await bad(SPAWN.replace("{{ item }}", "{{ nothing }}"))).toMatch(/fanout.inputs.item uses "\{\{ nothing \}\}"/);
    expect(await bad(SPAWN.replace("{{ inputs.ready }}", "{{ inputs.base }}").replace("[ready, base]", "[ready, base]"))).toBe("");
    expect(await bad(`${SPAWN}\n    outputs: { x: {} }`)).toMatch(/`outputs` does not apply to a fan-out step/);
    expect(await bad(SPAWN.replace("some_failed", "nope"))).toMatch(/on.nope: not an outcome of a fan-out step/);
    expect(await bad(SPAWN.replace("max_active: 2", "max_active: 0"))).toMatch(/max_active/);
    expect(await bad(SPAWN.replace("    fanout:", "    fanout:\n      extra: 1"))).toMatch(/extra/);
  });

  it("refuses a playbook that reaches itself through the fan-out child", async () => {
    const back = `
title: Back
steps:
  - id: plan
    script: { run: plan.sh }
    outputs: { ready: { type: list } }
  - id: again
    needs: [plan]
    inputs: [ready]
    fanout: { playbook: parent, items: "{{ inputs.ready }}", inputs: {} }
`;
    const errors = await errorsOf({ "parent.yaml": parent(SPAWN.replace("playbook: child", "playbook: back")), "child.yaml": CHILD, "back.yaml": back });
    expect(errors).toMatch(/leads back to this playbook/);
  });
});

describe("fan-out runs", () => {
  it("starts one child per item in its own new workspace, at most max_active at a time, then joins", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The cap: two of three, titled per item.
    expect(ctx.created.map((workspace) => workspace.title)).toEqual(["Work on a", "Work on b"]);
    expect(stepOf(ctx, run.id).status).toBe("running");
    const [a, b] = [await createChild(ctx, 1, "a"), await createChild(ctx, 2, "b")];
    expect(a.parent).toEqual({ runId: run.id, stepId: "spawn", key: "a" });
    await until(() => stepOf(ctx, run.id).fanout!.children.filter((child) => child.status === "running").length === 2);
    expect(ctx.created).toHaveLength(2);
    await end(ctx, a.id, "completed", { result: "ra" });
    await until(() => ctx.created.length === 3);
    const c = await createChild(ctx, 3, "c");
    await end(ctx, b.id, "completed", { result: "rb" });
    await end(ctx, c.id, "completed", { result: "rc" });
    await until(() => stepOf(ctx, run.id).status === "completed");
    const state = stepOf(ctx, run.id);
    expect(state.attempts.at(-1)!.outcome).toBe("all_completed");
    expect(state.outputs).toMatchObject({ total: 3, started: 3, completed: 3, failed: 0, canceled: 0, not_started: 0, any_failed: false });
    expect(JSON.parse(String(state.outputs.results))).toEqual([
      { key: "a", runId: a.id, outcome: "completed", output_result: "ra" },
      { key: "b", runId: b.id, outcome: "completed", output_result: "rb" },
      { key: "c", runId: c.id, outcome: "completed", output_result: "rc" },
    ]);
    expect(ctx.store.get(run.id)!.steps.after!.status).toBe("ready");
  });

  it("waits for every child when one fails, then routes on some_failed", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    const a = await createChild(ctx, 1, "a");
    const b = await createChild(ctx, 2, "b");
    await end(ctx, a.id, "failed");
    await until(() => ctx.created.length === 3);
    const c = await createChild(ctx, 3, "c");
    // The failure did not stop the others.
    expect(ctx.store.get(b.id)!.status).not.toBe("canceled");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stepOf(ctx, run.id).status).toBe("running");
    await end(ctx, b.id, "completed", { result: "rb" });
    await end(ctx, c.id, "completed", { result: "rc" });
    await until(() => stepOf(ctx, run.id).status === "completed");
    expect(stepOf(ctx, run.id).attempts.at(-1)!.outcome).toBe("some_failed");
    expect(stepOf(ctx, run.id).outputs).toMatchObject({ completed: 2, failed: 1, any_failed: true });
    // `on: some_failed: complete` lets the run go on.
    expect(ctx.store.get(run.id)!.steps.after!.status).toBe("ready");
  });

  it("fails the run on some_failed when `on` does not route it", async () => {
    const ctx = await setup({ "parent.yaml": parent(SPAWN.replace("\n    on: { some_failed: complete }", "")), "child.yaml": CHILD });
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    const a = await createChild(ctx, 1, "a");
    const b = await createChild(ctx, 2, "b");
    await end(ctx, a.id, "failed");
    await end(ctx, b.id, "completed", { result: "r" });
    await until(() => ctx.created.length === 3);
    const c = await createChild(ctx, 3, "c");
    await end(ctx, c.id, "completed", { result: "r" });
    await until(() => ctx.store.get(run.id)!.status === "failed");
  });

  it("never starts a child twice for a key: scans, ticks and a daemon restart find the same children", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    const a = await createChild(ctx, 1, "a");
    const b = await createChild(ctx, 2, "b");
    await until(() => stepOf(ctx, run.id).fanout!.children.filter((child) => child.status === "running").length === 2);
    const ids = stepOf(ctx, run.id).fanout!.children.map((child) => child.runId);
    await ctx.runtime.dispose();
    // A restart: the new runtime follows the persisted children, starting none again.
    const again = await ctx.boot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ctx.created).toHaveLength(2);
    expect(stepOf(ctx, run.id).fanout!.children.map((child) => child.runId)).toEqual(ids);
    // Children that ended while the daemon was down are noticed after it came back.
    await end(ctx, a.id, "completed", { result: "ra" });
    await end(ctx, b.id, "completed", { result: "rb" });
    await until(() => ctx.created.length === 3);
    expect(again).toBeDefined();
    await createChild(ctx, 3, "c").then((c) => end(ctx, c.id, "completed", { result: "rc" }));
    await until(() => stepOf(ctx, run.id).status === "completed");
    expect(ctx.created).toHaveLength(3);
  });

  it("reports a child whose start was lost with the restart as not_started", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    await ctx.runtime.dispose();
    // The reservations lived in memory: the managers of the two children can no longer create their runs.
    await ctx.boot();
    await until(() => stepOf(ctx, run.id).fanout!.children.filter((child) => child.status === "not_started").length >= 2);
    const lost = stepOf(ctx, run.id).fanout!.children.find((child) => child.status === "not_started")!;
    expect(lost.error).toMatch(/run was not created/);
  });

  it("reports an item whose templates do not render as not_started, with the reason, and still joins", async () => {
    const spawn = SPAWN.replace('item: "{{ item }}"', 'item: "{{ item.id }}"');
    const ctx = await setup({ "parent.yaml": parent(spawn), "child.yaml": CHILD });
    const run = await startParent(ctx);
    await until(() => stepOf(ctx, run.id).status === "completed");
    const state = stepOf(ctx, run.id);
    expect(state.fanout!.children.map((child) => child.status)).toEqual(["not_started", "not_started", "not_started"]);
    expect(state.fanout!.children[0]!.error).toMatch(/"\{\{ item.id \}\}" is not set for item 0/);
    expect(state.attempts.at(-1)!.outcome).toBe("some_failed");
    expect(state.outputs).toMatchObject({ started: 0, not_started: 3, any_failed: true });
    expect(ctx.created).toHaveLength(0);
  });

  it("fails the step on an unusable list, a missing key for objects, and clashing keys", async () => {
    const run = async (ready: string, spawn = SPAWN) => {
      const ctx = await setup({ "parent.yaml": parent(spawn), "child.yaml": CHILD });
      await writeFile(path.join(ctx.dir, ".paseo/plugins/playbooks/scripts/plan.sh"), `#!/bin/sh\necho '{"outputs": {"ready": ${ready}, "base": "main"}}'\n`);
      const started = await startParent(ctx);
      await until(() => ctx.store.get(started.id)!.status === "failed");
      return ctx.store.get(started.id)!.steps.spawn!.attempts.at(-1)?.report?.summary ?? "";
    };
    expect(await run('["a", "a"]')).toMatch(/same key "a"/);
    expect(await run('[{"id": "a"}]')).toMatch(/is an object: set `fanout.key`/);
  });

  it("joins an empty list at once with all_completed", async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.dir, ".paseo/plugins/playbooks/scripts/plan.sh"), `#!/bin/sh\necho '{"outputs": {"ready": [], "base": "main"}}'\n`);
    const run = await startParent(ctx);
    await until(() => stepOf(ctx, run.id).status === "completed");
    expect(stepOf(ctx, run.id).outputs).toMatchObject({ results: "[]", total: 0, any_failed: false });
    expect(ctx.created).toHaveLength(0);
  });

  it("cancels the active children and drops the waiting ones when the parent is canceled; not with cancel_children: false", async () => {
    for (const cascade of [true, false]) {
      const spawn = cascade ? SPAWN : SPAWN.replace("max_active: 2", "max_active: 2\n      cancel_children: false");
      const ctx = await setup({ "parent.yaml": parent(spawn), "child.yaml": CHILD });
      const run = await startParent(ctx);
      await until(() => ctx.created.length === 2);
      const a = await createChild(ctx, 1, "a");
      const b = await createChild(ctx, 2, "b");
      await until(() => stepOf(ctx, run.id).fanout!.children.filter((child) => child.status === "running").length === 2);
      await ctx.runtime.cancelRun(run.id, "stop", "from the panel");
      if (cascade) {
        expect(ctx.store.get(a.id)!.status).toBe("canceled");
        expect(ctx.store.get(b.id)!.status).toBe("canceled");
        expect(stepOf(ctx, run.id).fanout!.children.map((child) => child.status)).toEqual(["canceled", "canceled", "not_started"]);
      } else {
        expect(ctx.store.get(a.id)!.status).not.toBe("canceled");
        expect(ctx.store.get(b.id)!.status).not.toBe("canceled");
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ctx.created).toHaveLength(2);
      await ctx.runtime.dispose();
    }
  });

  it("keeps the children of earlier passes when the step runs again", async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.dir, ".paseo/plugins/playbooks/scripts/plan.sh"), `#!/bin/sh\necho '{"outputs": {"ready": ["a"], "base": "main"}}'\n`);
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 1);
    const a = await createChild(ctx, 1, "a");
    await end(ctx, a.id, "completed", { result: "r" });
    await until(() => stepOf(ctx, run.id).status === "completed");
    await ctx.store.mutate(run.id, (current) => {
      const state = current.steps.spawn!;
      state.status = "ready";
      state.loop = 1;
    });
    await (ctx.runtime as unknown as { tick(): Promise<void> }).tick();
    await until(() => stepOf(ctx, run.id).fanoutPast.length === 1);
    expect(stepOf(ctx, run.id).fanoutPast[0]!.children[0]!.key).toBe("a");
    expect(stepOf(ctx, run.id).fanout!.loop).toBe(1);
  });

  it("summarizes the lanes for the Playbooks screen, children and earlier passes included", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => ctx.created.length === 2);
    const child = await createChild(ctx, 1, "a");
    await until(() => stepOf(ctx, run.id).fanout!.children[0]!.status === "running");
    const summary = summarizeRun(ctx.store.get(run.id)!);
    expect(summary.fanouts.spawn!.children.map((entry) => [entry.key, entry.status])).toEqual([["a", "running"], ["b", "starting"], ["c", "pending"]]);
    expect(summarizeRun(ctx.store.get(child.id)!).parent).toEqual({ runId: run.id, stepId: "spawn", key: "a" });
  });

  it("refuses start_step and nudge_step for a fan-out step", async () => {
    const ctx = await setup();
    const run = await startParent(ctx);
    await until(() => stepOf(ctx, run.id).status === "running");
    await expect(ctx.runtime.startStep("mgr0", run.id, "spawn", "")).rejects.toThrow(/fan-out step/);
    await expect(ctx.runtime.nudgeStep(run.id, "spawn", "hi")).rejects.toThrow(/fan-out step/);
  });
});

describe("fan-out engine", () => {
  it("summarizes counts and picks pending children under the cap", () => {
    const child = (key: string, status: engine.FanoutChildStatus) => ({ key, index: 0, item: "1", inputs: {}, workspaceName: "", status, runId: null, workspaceId: null, error: null, startedAt: null, endedAt: null, outputs: {} });
    const state = { attempt: 1, loop: 0, startedAt: "", children: [child("a", "running"), child("b", "pending"), child("c", "pending"), child("d", "failed")] };
    expect(engine.childrenToStart(state, 2).map((entry) => entry.key)).toEqual(["b"]);
    expect(engine.fanoutSummaryText(state)).toBe("1 of 4 done: 1 failed, 1 running, 2 waiting");
    expect(engine.fanoutJoined(state)).toBe(false);
  });
});
