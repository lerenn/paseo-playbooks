import { chmod, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const manager = { id: "m", workspaceId: "ws", cwd: "/" };
const now = () => new Date().toISOString();

function fakePaseo(dir: string, options: { failCreate?: boolean } = {}) {
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
        if (options.failCreate) throw new Error("no capacity");
        await new Promise((resolve) => setTimeout(resolve, 5));
        const id = `step-${created.length + 1}`;
        created.push(id);
        return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
      },
    },
  };
  const providers = { listModels: async (provider: string) => ({ provider, models: [{ id: "claude-haiku-5-5" }] }) };
  return { paseo: { agents: { ref }, workspaces: { ref: () => ({ ...workspace, refresh: async () => workspace }) }, providers }, created, sent };
}

async function setup(playbook: string, options: { failCreate?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "autostart-ready-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "p.yaml"), playbook);
  await writeFile(path.join(root, "scripts", "ok.sh"), `#!/bin/sh\necho '{"summary": "done", "outputs": {}}'\n`);
  await chmod(path.join(root, "scripts", "ok.sh"), 0o755);
  await writeFile(path.join(root, "scripts", "bad.sh"), `#!/bin/sh\nexit 3\n`);
  await chmod(path.join(root, "scripts", "bad.sh"), 0o755);
  const loaded = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "p")!;
  expect(loaded.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir, options);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, loaded, store, runtime, ...fake };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const toManager = (sent: Array<{ agentId: string; text: string }>) => sent.filter((entry) => entry.agentId === "m");
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const AFTER_SCRIPT = `
title: P
steps:
  - id: ci
    script: { run: ok.sh }
  - id: babysit
    needs: [ci]
    role: { name: implementer }
`;

describe("ready agent steps start by themselves", () => {
  it("after a script step, with an empty brief and no wake-up of the manager", async () => {
    const { loaded, store, runtime, created, sent } = await setup(AFTER_SCRIPT);
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.babysit!.status === "running");
    expect(created).toHaveLength(1);
    expect(store.get(run.id)!.steps.babysit!.attempts[0]!.brief).toBe("");
    await settle();
    expect(toManager(sent)).toEqual([]);
    expect(store.get(run.id)!.inbox).toEqual([]);
    // The run log has the completed script step.
    expect(store.get(run.id)!.history.some((entry) => entry.type === "step_completed" && entry.stepId === "ci")).toBe(true);
  });

  it("wakes the manager for a script step with manage.notify, saying the next step starts by itself", async () => {
    const { loaded, store, runtime, sent } = await setup(AFTER_SCRIPT.replace("script: { run: ok.sh }", "script: { run: ok.sh }\n    manage: { notify: true }"));
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => toManager(sent).length > 0);
    expect(toManager(sent)[0]!.text).toMatch(/script step "ci"[\s\S]*Ready: babysit \(starts by itself\)/);
    await until(() => store.get(run.id)!.steps.babysit!.status === "running");
  });

  it("after a gate the manager decided", async () => {
    const { loaded, store, runtime, created } = await setup(`
title: P
steps:
  - id: ok
    gate: { question: Go? }
  - id: work
    needs: [ok]
    role: { name: implementer }
`);
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    const gate = await runtime.requestGate("m", run.id, "ok", "Go?", "");
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: "yes", by: "laptop", via: "panel", now: now() });
    await until(() => store.get(run.id)!.steps.work!.status === "running");
    expect(created).toHaveLength(1);
  });

  it("after a loop-back", async () => {
    const { loaded, store, runtime, created } = await setup(`
title: P
steps:
  - id: impl
    role: { name: implementer }
  - id: review
    needs: [impl]
    outcomes: [approved, changes]
    on: { changes: { goto: impl, max_loops: 2 } }
    role: { name: implementer, agent: { provider: claude, model: claude-haiku-5-5 } }
    manage: { auto_start: false }
`);
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.impl!.status === "running");
    await runtime.report("step-1", { outcome: "success", summary: "x", outputs: {} });
    await runtime.onStepTurnEnded(run.id, "step-1", "completed");
    await runtime.completeStep("m", run.id, "impl", { outcome: "success" });
    expect(store.get(run.id)!.steps.review!.status).toBe("ready");
    await runtime.startStep("m", run.id, "review", "look at X");
    await runtime.report("step-2", { outcome: "changes", summary: "fix", outputs: {} });
    await runtime.onStepTurnEnded(run.id, "step-2", "completed");
    await runtime.completeStep("m", run.id, "review", { outcome: "changes" });
    // impl is ready again and starts by itself; the opted-out review waits for a brief afterwards.
    await until(() => store.get(run.id)!.steps.impl!.attempts.length === 2);
    expect(store.get(run.id)!.steps.impl!.status).toBe("running");
    expect(created).toHaveLength(3);
  });

  it("never starts a step twice: the manager's start_step racing the plugin creates one agent", async () => {
    const { loaded, store, runtime, created } = await setup(AFTER_SCRIPT);
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.babysit!.status !== "pending");
    await Promise.allSettled([runtime.startStep("m", run.id, "babysit", "mine"), runtime.startStep("m", run.id, "babysit", "mine")]);
    await settle();
    expect(created).toHaveLength(1);
    expect(store.get(run.id)!.steps.babysit!.attempts).toHaveLength(1);
  });

  it("start_playbook's hold (autoStart: false) keeps the first steps ready, later ones start by themselves", async () => {
    const { loaded, store, runtime, created } = await setup(`
title: P
steps:
  - id: a
    role: { name: implementer }
  - id: b
    needs: [a]
    role: { name: implementer }
`);
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook!, hold: true });
    await settle();
    expect(created).toHaveLength(0);
    expect(store.get(run.id)!.steps.a!.status).toBe("ready");
    await runtime.startStep("m", run.id, "a", "brief");
    expect(store.get(run.id)!.held).toEqual([]);
    await runtime.report("step-1", { outcome: "success", summary: "x", outputs: {} });
    await runtime.onStepTurnEnded(run.id, "step-1", "completed");
    await runtime.completeStep("m", run.id, "a", { outcome: "success" });
    await until(() => store.get(run.id)!.steps.b!.status === "running");
  });
});

describe("opt-out: manage.auto_start false", () => {
  const OPT_OUT = AFTER_SCRIPT.replace("role: { name: implementer }", "role: { name: implementer }\n    manage: { auto_start: false }");

  it("leaves the step ready and wakes the manager, once, with a message to start it with a brief", async () => {
    const { loaded, store, runtime, created, sent } = await setup(OPT_OUT);
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => toManager(sent).length > 0);
    await settle();
    expect(store.get(run.id)!.steps.babysit!.status).toBe("ready");
    expect(created).toHaveLength(0);
    expect(toManager(sent)).toHaveLength(1);
    expect(toManager(sent)[0]!.text).toMatch(/babysit/);
    expect(toManager(sent)[0]!.text).toMatch(/start_step/);
    await runtime.startStep("m", run.id, "babysit", "watch PR 7");
    expect(store.get(run.id)!.steps.babysit!.attempts[0]!.brief).toBe("watch PR 7");
  });

  it("a manager that was mid-turn is told when its turn ends", async () => {
    const { loaded, store, runtime, sent } = await setup(OPT_OUT);
    runtime.onTurnStarted("m");
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.babysit!.status === "ready");
    await settle();
    expect(toManager(sent)).toEqual([]);
    await runtime.onManagerTurnEnded("m");
    await until(() => toManager(sent).length > 0);
    expect(toManager(sent)[0]!.text).toMatch(/babysit/);
  });

  it("is refused on a script step", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "autostart-ready-"));
    temps.push(dir);
    const root = path.join(dir, ".paseo/plugins/playbooks");
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "scripts", "x.sh"), "#!/bin/sh\n");
    await chmod(path.join(root, "scripts", "x.sh"), 0o755);
    await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
    await writeFile(path.join(root, "p.yaml"), "title: P\nsteps:\n  - id: s\n    script: { run: x.sh }\n    manage: { auto_start: false }\n");
    const entry = (await loadPlaybooks(dir)).entries.find((e) => e.id === "p")!;
    expect(entry.errors.join("\n")).toMatch(/manage\.auto_start. only applies to an agent step/);
  });
});

describe("a quiet manager is never a silent stall", () => {
  it("wakes for a script failure", async () => {
    const { loaded, store, runtime, sent } = await setup(AFTER_SCRIPT.replace("ok.sh", "bad.sh"));
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.status === "failed");
    await until(() => toManager(sent).length > 0);
    expect(toManager(sent)[0]!.text).toMatch(/ended failure/);
  });

  it("wakes when the plugin could not start a ready step, once", async () => {
    const { loaded, store, runtime, sent } = await setup(AFTER_SCRIPT, { failCreate: true });
    const run = await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => toManager(sent).length > 0);
    await settle();
    expect(store.get(run.id)!.steps.babysit!.status).toBe("ready");
    expect(toManager(sent)).toHaveLength(1);
    expect(toManager(sent)[0]!.text).toMatch(/could not start "babysit" by itself \(no capacity\)/);
  });

  it("wakes when a gate comes after a quiet script step", async () => {
    const { loaded, sent, runtime } = await setup(`
title: P
steps:
  - id: ci
    script: { run: ok.sh }
  - id: ok
    needs: [ci]
    gate: { question: Go? }
`);
    await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => toManager(sent).length > 0);
    expect(toManager(sent)[0]!.text).toMatch(/Ready: ok|Gate step "ok" is ready/);
  });

  it("wakes when the run ends after a script step", async () => {
    const { loaded, sent, runtime } = await setup("title: P\nsteps:\n  - id: ci\n    script: { run: ok.sh }\n");
    await runtime.startPlaybook(manager, "p", {}, { playbook: loaded.playbook! });
    await until(() => toManager(sent).length > 0);
    expect(toManager(sent)[0]!.text).toMatch(/run is completed/i);
  });
});
