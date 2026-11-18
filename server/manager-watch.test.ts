import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MANAGER_NUDGE, GateSchema, type Gate } from "../shared/types";
import { newRun, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { nudgeInterval } from "./manager-watch";
import { DEFAULT_SIDEKICK_WATCH } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MIN = 60_000;
const PLAYBOOK = (manager = "") => `
title: Release
${manager}
steps:
  - id: release
    role: { name: implementer }
    outputs: { pr: {} }
`;

/** A daemon API whose manager can be made busy or given a pending question. */
function fakePaseo() {
  const sent: Array<{ agentId: string; text: string }> = [];
  const manager = { status: "idle", pending: [] as Array<{ id: string; name: string; kind: string }> };
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: agentId === "m" ? manager.status : "running", provider: "claude", model: null, archivedAt: null, pendingPermissions: agentId === "m" ? manager.pending : [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  return { paseo: { agents: { ref, list: async () => ({ entries: [] }) } }, sent, manager };
}

async function setup(options: { manager?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "mwatch-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "release.yaml"), PLAYBOOK(options.manager));
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "release")!.playbook!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
  startAttempt(run, "release", { agentId: "step-1", brief: "", now: new Date().toISOString(), readonlySnapshot: null });
  await store.create(run);
  const fake = fakePaseo();
  const runtime = new Runtime(store, { debounceMs: 0 } as never);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  await runtime.report("step-1", { outcome: "failure", summary: "CI is red", outputs: {} });
  await runtime.onTurnEnded("step-1", "completed");
  await runtime.onManagerTurnEnded("m");
  fake.sent.length = 0;
  const reportedAt = Date.parse(store.get("run_x")!.steps.release!.attempts[0]!.endedAt!);
  const nudges = () => fake.sent.filter((entry) => entry.agentId === "m" && /still waiting for you/.test(entry.text));
  const events = async (type: string) => (await (runtime as unknown as { bus: { recent: (q: object) => Promise<{ events: unknown[] }> } }).bus.recent({ types: [type] })).events;
  /** One watchdog look at `t` minutes after the report. */
  const look = async (minutes: number) => {
    await runtime.onManagerTurnEnded("m"); // the fake manager's turn from the previous nudge is over
    await runtime.watchEvents(reportedAt + minutes * MIN);
  };
  const gate = (decider: Gate["decider"], escalated: string | null = null) =>
    store.mutate("run_x", (run) => {
      run.gates.push(GateSchema.parse({ id: "g1", kind: "gate", stepId: "release", gotoTarget: null, status: "pending", message: "ok?", requestedAt: new Date().toISOString(), comment: null, decidedBy: null, decidedVia: null, decider, escalated, decidedAt: null }));
    });
  return { store, runtime, reportedAt, nudges, events, look, gate, ...fake };
}

describe("the manager watchdog", () => {
  it("nudges the idle manager once the step waited 3 minutes, naming the step and its outcome", async () => {
    const { nudges, look, sent } = await setup();
    await look(2);
    expect(nudges()).toHaveLength(0);
    await look(3);
    expect(nudges()).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/run_x · still waiting for you/);
    expect(sent[0]!.text).toMatch(/step "release" \(attempt 1\) reported "failure" 3 min ago: CI is red/);
    expect(sent[0]!.text).toMatch(/complete_step/);
    await look(3.5); // nothing new within the window
    expect(nudges()).toHaveLength(1);
  });

  it("backs off 3, 6, 12, 24, 30, 30 minutes", async () => {
    const policy = DEFAULT_MANAGER_NUDGE;
    expect([0, 1, 2, 3, 4, 5, 9].map((sent) => nudgeInterval(policy, sent) / MIN)).toEqual([3, 6, 12, 24, 30, 30, 30]);
    const { nudges, look } = await setup();
    // Nudges at 3, 9 (+6), 21 (+12), 45 (+24), 75 (+30), 105 (+30).
    for (const [minute, count] of [[3, 1], [8, 1], [9, 2], [20, 2], [21, 3], [44, 3], [45, 4], [74, 4], [75, 5], [104, 5], [105, 6]] as const) {
      await look(minute);
      expect(nudges(), `at ${minute} min`).toHaveLength(count);
    }
  });

  it("emits step.waiting_manager_stuck after the second nudge, once; a new report re-arms it", async () => {
    const { nudges, look, events, runtime, store } = await setup();
    await look(3);
    expect(await events("step.waiting_manager_stuck")).toHaveLength(0);
    await look(9);
    expect(nudges()).toHaveLength(2);
    const stuck = await events("step.waiting_manager_stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ payload: { runId: "run_x", stepId: "release", outcome: "failure", nudges: 2, managerAgentId: "m" } });
    await look(21);
    expect(nudges()).toHaveLength(3);
    expect(await events("step.waiting_manager_stuck")).toHaveLength(1);
    // Progress: nudge_step reopens the attempt, it reports again: a new episode.
    await store.mutate("run_x", (run) => {
      const attempt = run.steps.release!.attempts[0]!;
      attempt.endedAt = new Date(Date.parse(attempt.endedAt!) + 1000).toISOString();
    });
    await runtime.onManagerTurnEnded("m");
    await runtime.watchEvents(Date.now() + 120 * MIN); // counted afresh: 1 nudge
    expect(store.get("run_x")!.managerWatch.steps.release).toMatchObject({ count: 1, stuckEmitted: false });
    await runtime.onManagerTurnEnded("m");
    await runtime.watchEvents(Date.now() + 240 * MIN);
    expect(await events("step.waiting_manager_stuck")).toHaveLength(2);
  });

  it("does not nudge while the manager is running a turn", async () => {
    const { nudges, look, manager } = await setup();
    manager.status = "running";
    await look(10);
    expect(nudges()).toHaveLength(0);
    manager.status = "idle";
    await look(11);
    expect(nudges()).toHaveLength(1);
  });

  it("does not nudge, nor emit, while the manager has a question or permission request open; announces it once per episode", async () => {
    const { nudges, look, manager, events, store } = await setup();
    manager.pending = [{ id: "q1", name: "AskUserQuestion", kind: "question" }];
    await look(1);
    expect(await events("manager.question_pending")).toHaveLength(0);
    await look(30);
    await look(60);
    expect(nudges()).toHaveLength(0);
    expect(await events("step.waiting_manager_stuck")).toHaveLength(0);
    const pending = await events("manager.question_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ payload: { runId: "run_x", managerAgentId: "m" } });
    // Answered: the episode ends; the step is nudged; a new question is a new episode.
    manager.pending = [];
    await look(61);
    expect(store.get("run_x")!.managerWatch.question).toBeNull();
    expect(nudges()).toHaveLength(1);
    manager.pending = [{ id: "q2", name: "Bash", kind: "tool" }];
    await look(62);
    await look(66);
    expect(await events("manager.question_pending")).toHaveLength(2);
  });

  it("does not nudge while a gate is held by a human, an escalated one, or a role", async () => {
    for (const [decider, escalated] of [[{ by: "human" }, null], [{ by: "manager" }, "too risky"], [{ by: "role", role: "reviewer" }, null]] as const) {
      const { nudges, look, gate, events } = await setup();
      await gate(decider as Gate["decider"], escalated);
      await look(30);
      await look(90);
      expect(nudges(), JSON.stringify(decider)).toHaveLength(0);
      expect(await events("step.waiting_manager_stuck")).toHaveLength(0);
    }
  });

  it("nudges while a gate is held by the manager itself", async () => {
    const { nudges, look, gate } = await setup();
    await gate({ by: "manager" });
    await look(3);
    expect(nudges()).toHaveLength(1);
  });

  it("does not nudge a paused run, an ended run, or a step that moved", async () => {
    const paused = await setup();
    await paused.store.mutate("run_x", (run) => void (run.pausedAt = new Date().toISOString()));
    await paused.look(30);
    expect(paused.nudges()).toHaveLength(0);

    const moved = await setup();
    await moved.store.mutate("run_x", (run) => void (run.steps.release!.status = "completed"));
    await moved.look(30);
    expect(moved.nudges()).toHaveLength(0);

    const ended = await setup();
    await ended.store.mutate("run_x", (run) => void (run.status = "canceled"));
    await ended.look(30);
    expect(ended.nudges()).toHaveLength(0);
  });

  it("does not nudge a step that is not reported", async () => {
    const { nudges, look, store } = await setup();
    await store.mutate("run_x", (run) => {
      run.steps.release!.status = "running";
      run.steps.release!.attempts[0]!.endedAt = null;
    });
    await look(30);
    expect(nudges()).toHaveLength(0);
  });

  it("does nothing with manager.nudge.enabled: false", async () => {
    const { nudges, look, manager, events } = await setup({ manager: "manager: { nudge: { enabled: false } }" });
    manager.pending = [{ id: "q1", name: "AskUserQuestion", kind: "question" }];
    await look(30);
    manager.pending = [];
    await look(90);
    expect(nudges()).toHaveLength(0);
    expect(await events("manager.question_pending")).toHaveLength(0);
  });

  it("honours manager.nudge.after and max_interval", async () => {
    const { nudges, look } = await setup({ manager: "manager: { nudge: { after: 1m, max_interval: 2m } }" });
    await look(1);
    expect(nudges()).toHaveLength(1);
    await look(3);
    expect(nudges()).toHaveLength(2);
    await look(5);
    expect(nudges()).toHaveLength(3);
  });

  it("keeps its count across a restart: no repeated nudge, no storm", async () => {
    const { nudges, look, store, runtime, reportedAt, paseo } = await setup();
    await look(3);
    expect(nudges()).toHaveLength(1);
    await runtime.dispose();
    const again = new Runtime(store, { debounceMs: 0 } as never);
    runtimes.push(again);
    const next = fakePaseo();
    await again.attach(next.paseo as never);
    void paseo;
    await again.watchEvents(reportedAt + 4 * MIN);
    expect(next.sent.filter((entry) => /still waiting for you/.test(entry.text))).toHaveLength(0);
    await again.onManagerTurnEnded("m"); // its restart prompt's turn is over
    await again.watchEvents(reportedAt + 9 * MIN);
    expect(next.sent.filter((entry) => /still waiting for you/.test(entry.text))).toHaveLength(1);
    expect(store.get("run_x")!.managerWatch.steps.release!.count).toBe(2);
  });

  it("refuses a bad manager.nudge block and reads it from the defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mwatch-load-"));
    temps.push(dir);
    const root = path.join(dir, ".paseo/playbooks");
    await mkdir(path.join(root, "defaults"), { recursive: true });
    await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
    await writeFile(path.join(root, "defaults/main.yaml"), "manager: { nudge: { after: 10m, max_interval: 20m } }\n");
    await writeFile(path.join(root, "ok.yaml"), PLAYBOOK());
    await writeFile(path.join(root, "own.yaml"), PLAYBOOK("manager: { nudge: { enabled: false } }"));
    await writeFile(path.join(root, "bad.yaml"), PLAYBOOK("manager: { nudge: { after: soon } }"));
    await writeFile(path.join(root, "inverted.yaml"), PLAYBOOK("manager: { nudge: { after: 10m, max_interval: 5m } }"));
    await writeFile(path.join(root, "typo.yaml"), PLAYBOOK("manager: { nudge: { afterr: 3m } }"));
    const { entries } = await loadPlaybooks(dir);
    const by = (id: string) => entries.find((entry) => entry.id === id)!;
    expect(by("ok").playbook!.managerNudge).toEqual({ enabled: true, afterMs: 10 * MIN, maxIntervalMs: 20 * MIN });
    expect(by("own").playbook!.managerNudge).toEqual({ enabled: false, afterMs: 10 * MIN, maxIntervalMs: 20 * MIN });
    expect(by("bad").errors.join("\n")).toMatch(/manager.nudge.after: expected a duration/);
    expect(by("inverted").errors.join("\n")).toMatch(/max_interval must not be shorter/);
    expect(by("typo").errors.length).toBeGreaterThan(0);
  });

  it("is in the Sidekick's default subscription", () => {
    expect(DEFAULT_SIDEKICK_WATCH).toEqual(expect.arrayContaining(["step.waiting_manager_stuck", "manager.question_pending"]));
  });
});
