import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "./engine";
import { loadPlaybooks } from "./loader";
import { GATE_LABEL, Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A playbook with no manager: two agent steps, a human gate, a role gate and a step that may fail.
const NONE = `
title: None
manager: { mode: none }
steps:
  - id: build
    outcomes: [success, failure]
    role: { name: implementer }
  - id: approve
    needs: [build]
    gate: { question: Ship it? }
  - id: judge
    needs: [approve]
    gate: { question: Really?, decider: { by: role, role: reviewer } }
  - id: ship
    needs: [judge]
    outcomes: [success, failure]
    role: { name: implementer }
`;

function fakePaseo(dir: string) {
  const created: Array<{ id: string; labels: Record<string, string>; parent: string | undefined }> = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived: string[] = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: archived.includes(agentId) ? "now" : null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => void archived.push(agentId),
    reload: async () => undefined,
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  const workspace = {
    id: "ws",
    projectId: "p",
    workspaceDirectory: dir,
    projectRootPath: dir,
    agents: {
      create: async (input: { labels: Record<string, string>; parent?: string }) => {
        const id = `agent${created.length + 1}`;
        created.push({ id, labels: input.labels, parent: input.parent });
        return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
      },
    },
  };
  const providers = { listModels: async (provider: string) => ({ provider, models: [{ id: "claude-haiku-5-5" }] }) };
  return { paseo: { agents: { ref, list: async () => ({ entries: [] }) }, workspaces: { ref: () => ({ ...workspace, refresh: async () => workspace }) }, providers }, created, sent, archived };
}

async function setup(files: Record<string, string> = { "none.yaml": NONE }, defaults?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "mm-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  if (defaults) await writeFile(path.join(root, "defaults/main.yaml"), defaults);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, store, runtime, ...fake };
}

const caller = { id: "caller", workspaceId: "ws", cwd: "/" };
const now = () => new Date().toISOString();

/** The step agent reports, then its turn ends: the plugin applies the report. */
async function finish(runtime: Runtime, runId: string, agentId: string, outcome: string, summary = `did ${outcome}`) {
  await runtime.report(agentId, { outcome, summary, outputs: {} });
  await runtime.onStepTurnEnded(runId, agentId, "completed");
}

describe("manager.mode: loading", () => {
  const errorsOf = async (yaml: string, defaults?: string) => {
    const { dir } = await setup({ "m.yaml": yaml }, defaults);
    return (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "m")!;
  };
  const steps = "steps:\n  - id: a\n    role: { name: implementer }\n";

  it("defaults to always_on, reads none, and a playbook overrides the repository default", async () => {
    expect((await errorsOf(`title: M\n${steps}`)).playbook!.managerMode).toBe("always_on");
    expect((await errorsOf(`title: M\nmanager: { mode: none }\n${steps}`)).playbook!.managerMode).toBe("none");
    expect((await errorsOf(`title: M\n${steps}`, "manager: { lifecycle: none }\n")).playbook!.managerMode).toBe("none");
    expect((await errorsOf(`title: M\nmanager: { mode: always_on }\n${steps}`, "manager: { lifecycle: none }\n")).playbook!.managerMode).toBe("always_on");
    // The manager's own settings and its mode on the defaults keep working next to it.
    const entry = await errorsOf(`title: M\nmanager: { mode: none }\n${steps}`, "manager: { mode: default, lifecycle: always_on }\n");
    expect(entry.errors).toEqual([]);
    expect(entry.playbook!.manager.mode).toBe("default");
  });

  it("refuses on_demand (not supported yet), unknown values, and none on a singleton", async () => {
    expect((await errorsOf(`title: M\nmanager: { mode: on_demand }\n${steps}`)).errors.join("\n")).toMatch(/on_demand` is not supported yet/);
    expect((await errorsOf(`title: M\nmanager: { mode: sometimes }\n${steps}`)).errors.join("\n")).toMatch(/not a manager mode/);
    expect((await errorsOf(`title: M\nmanager: { mode: none }\nsingleton: {}\nsteps:\n  - id: a\n    role: { name: reviewer }\n`)).errors.join("\n")).toMatch(/does not apply to a singleton/);
    expect((await errorsOf(`title: M\n${steps}`, "manager: { lifecycle: on_demand }\n")).errors.join("\n")).toMatch(/not supported yet/);
  });
});

describe("manager.mode: none", () => {
  it("creates no manager, starts the first step itself (top-level agent) and queues nothing", async () => {
    const { runtime, store, created, sent } = await setup();
    const run = await runtime.startPlaybook(caller, "none", {});
    expect(run.managerAgentId).toBe("");
    const after = store.get(run.id)!;
    expect(after.steps.build!.status).toBe("running");
    expect(created).toHaveLength(1);
    expect(created[0]!.parent).toBeUndefined();
    expect(created[0]!.labels["playbooks/step"] ?? Object.values(created[0]!.labels)).toBeTruthy();
    expect(after.inbox).toEqual([]);
    expect(sent.filter((entry) => entry.agentId === "caller")).toEqual([]);
  });

  it("applies every reported outcome, opens the human gate in the panel, and goes on once it is decided", async () => {
    const { runtime, store, created } = await setup();
    const run = await runtime.startPlaybook(caller, "none", {});
    await finish(runtime, run.id, "agent1", "success");
    let current = store.get(run.id)!;
    expect(current.steps.build!.status).toBe("completed");
    expect(current.steps.approve!.status).toBe("waiting");
    const gate = current.gates.find((candidate) => candidate.stepId === "approve")!;
    expect(gate).toMatchObject({ status: "pending", decider: { by: "human" } });
    expect(current.inbox).toEqual([]);
    // The human decides in the panel: the plugin opens the role gate and starts its decider, top-level.
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: "", by: "me", via: "panel", now: now() });
    current = store.get(run.id)!;
    const role = current.gates.find((candidate) => candidate.stepId === "judge")!;
    expect(role.decider.by).toBe("role");
    const decider = created.find((agent) => agent.labels[GATE_LABEL] === role.id)!;
    expect(decider.parent).toBeUndefined();
    await runtime.reportGateDecision(decider.id, { decision: "approved", comment: "looks fine" });
    current = store.get(run.id)!;
    expect(current.steps.ship!.status).toBe("running");
    await finish(runtime, run.id, created.at(-1)!.id, "success");
    expect(store.get(run.id)!.status).toBe("completed");
  });

  it("a manager-decided gate is a human gate", async () => {
    const { runtime, store } = await setup({ "m.yaml": "title: M\nmanager: { mode: none }\nsteps:\n  - id: a\n    gate: { question: ok?, decider: { by: manager } }\n" });
    const run = await runtime.startPlaybook(caller, "m", {});
    expect(store.get(run.id)!.gates[0]).toMatchObject({ status: "pending", decider: { by: "human" } });
  });

  it("a failure stops the run in its failed state, with the step's text, and emits run.failed", async () => {
    const { runtime, store } = await setup();
    await runtime.watchEvents();
    const run = await runtime.startPlaybook(caller, "none", {});
    await finish(runtime, run.id, "agent1", "failure", "tests are red");
    const current = store.get(run.id)!;
    expect(current.status).toBe("failed");
    expect(current.failure).toMatch(/build/);
    expect(current.failure).toMatch(/tests are red/);
    await runtime.watchEvents();
    expect((await runtime.bus.recent()).events.some((event) => event.type === "run.failed")).toBe(true);
  });

  it("retries only when the YAML says so", async () => {
    const { runtime, store, created } = await setup({ "r.yaml": "title: R\nmanager: { mode: none }\nsteps:\n  - id: a\n    retries: 1\n    outcomes: [success, failure]\n    role: { name: implementer }\n" });
    const run = await runtime.startPlaybook(caller, "r", {});
    await finish(runtime, run.id, "agent1", "failure", "flaky");
    expect(store.get(run.id)!.steps.a!.status).toBe("running");
    expect(created).toHaveLength(2);
    await finish(runtime, run.id, "agent2", "failure", "flaky again");
    expect(store.get(run.id)!.status).toBe("failed");
  });

  it("a step that times out fails the run with a clear text; an agent that ended without reporting is a failure", async () => {
    const { runtime, store, created } = await setup();
    const run = await runtime.startPlaybook(caller, "none", {});
    await (runtime as unknown as { onTimeout(runId: string, stepId: string, agentId: string, ms: number): Promise<void> }).onTimeout(run.id, "build", created[0]!.id, 120_000);
    expect(store.get(run.id)!.status).toBe("failed");
    expect(store.get(run.id)!.failure).toMatch(/timed out after 2 min/);
    const second = await runtime.startPlaybook(caller, "none", { });
    await runtime.onStepTurnEnded(second.id, created.at(-1)!.id, "completed");
    await runtime.onStepTurnEnded(second.id, created.at(-1)!.id, "completed");
    expect(store.get(second.id)!.status).toBe("failed");
    expect(store.get(second.id)!.failure).toMatch(/without reporting/);
  });

  it("refuses the manager's tools on it, and restart_run restarts it without a manager", async () => {
    const { runtime, store, created } = await setup();
    const run = await runtime.startPlaybook(caller, "none", {});
    await expect(runtime.startStep("caller", run.id, "build", "")).rejects.toThrow(/no Playbook Manager \(manager.mode: none\)/);
    await expect(runtime.completeStep("caller", run.id, "build", { outcome: "success" })).rejects.toThrow(/no Playbook Manager/);
    await expect(runtime.requestGate("caller", run.id, "approve", "", "")).rejects.toThrow(/no Playbook Manager/);
    await finish(runtime, run.id, "agent1", "failure", "red");
    expect(store.get(run.id)!.status).toBe("failed");
    const { run: restarted, newManager } = await runtime.restartRun(run.id, "build", "try again", "me", "panel", { id: "taker", workspaceId: "ws" });
    expect(newManager).toBe(false);
    expect(restarted.managerAgentId).toBe("");
    expect(store.get(run.id)!.steps.build!.status).toBe("running");
    expect(created.every((agent) => agent.parent === undefined)).toBe(true);
  });

  it("starts from the panel's same-workspace path without creating a manager agent", async () => {
    const { runtime, store, created } = await setup();
    const started = await runtime.startFromPanel({ workspaceId: "ws", playbook: "none", inputs: {}, force: false, sameWorkspace: true });
    expect(started).toMatchObject({ status: "started", managerAgentId: "" });
    expect(store.get((started as { runId: string }).runId)!.steps.build!.status).toBe("running");
    expect(created).toHaveLength(1);
  });

  it("a report recorded but not applied when the daemon stopped is applied after a restart", async () => {
    const { runtime, store, dir, paseo } = await setup();
    const run = await runtime.startPlaybook(caller, "none", {});
    await runtime.report("agent1", { outcome: "success", summary: "done", outputs: {} });
    await store.mutate(run.id, (current) => engine.endTurn(current, "agent1", { turnEnd: "completed", lastMessage: null, now: now() }));
    expect(store.get(run.id)!.steps.build!.status).toBe("reported");
    const again = new Runtime(store);
    runtimes.push(again);
    await again.attach(paseo as never);
    expect(store.get(run.id)!.steps.build!.status).toBe("completed");
    expect(store.get(run.id)!.steps.approve!.status).toBe("waiting");
    void dir;
  });

  it("the step agent's prompt has no manager in it", async () => {
    const { prompts } = { prompts: await import("./prompts") };
    const { dir } = await setup();
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "none")!.playbook!;
    const step = playbook.steps.find((candidate) => candidate.id === "build")!;
    const text = prompts.stepSystemPrompt(playbook, step, playbook.roles.implementer!);
    expect(text).toMatch(/this run has no Playbook Manager/);
    expect(text).toMatch(/the plugin applies the outcome you report/);
    expect(text).not.toMatch(/Playbook Manager agent/);
  });
});
