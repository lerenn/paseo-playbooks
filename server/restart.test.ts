import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { restartBlocker } from "../shared/types";
import { cancelRun, completeStep, endTurn, failRun, newRun, readySteps, recordReport, restartRun, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { runListing } from "./tools";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** investigate → (implement ∥ docs) → review, with an auto after-task. */
const MAIN = `
title: Main
inputs:
  request: { required: true }
steps:
  - id: investigate
    role: { name: investigator }
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: { name: implementer }
    needs: [investigate]
    inputs: [plan]
    outcomes: [success, give_up]
    on:
      give_up: fail
  - id: docs
    role: { name: reviewer }
    needs: [investigate]
    outputs: { page: {} }
  - id: review
    role: { name: reviewer }
    needs: [implement, docs]
after:
  - id: retro
    role: { name: reviewer }
  - id: notify
    role: { name: reviewer }
    trigger: manual
`;

async function playbook(): Promise<Playbook> {
  const dir = await mkdtemp(path.join(tmpdir(), "restart-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "main.yaml"), MAIN);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "main")!;
  expect(entry.errors).toEqual([]);
  return entry.playbook!;
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++)).toISOString();

function start(pb: Playbook): Run {
  return newRun({ id: "run_r", playbook: pb, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "Add X" }, now: now() });
}

function begin(run: Run, stepId: string): string {
  const agentId = `a-${stepId}-${clock}`;
  startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
  return agentId;
}

function step(run: Run, stepId: string, outcome = "success", outputs: Record<string, string> = {}) {
  const agentId = begin(run, stepId);
  recordReport(run, agentId, { outcome, summary: `${stepId} ${outcome}`, outputs }, now());
  endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  return completeStep(run, stepId, { outcome, now: now() });
}

describe("restart a finished run from a step", () => {
  it("reopens a canceled run: the step runs again, finished steps keep their outputs, after-tasks run at the end", async () => {
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "the plan" });
    step(run, "docs", "success", { page: "docs.md" });
    begin(run, "implement");
    cancelRun(run, "canceled from the panel", now());
    expect(run.status).toBe("canceled");
    expect(run.after.retro!.status).toBe("canceled");

    const fx = restartRun(run, "implement", { comment: "use the new API", by: "laptop", now: now() });
    expect(run.status).toBe("running");
    expect(run.failure).toBeNull();
    expect(readySteps(run)).toEqual(["implement"]);
    expect(run.steps.docs).toMatchObject({ status: "completed", outputs: { page: "docs.md" } });
    expect(run.steps.investigate!.outputs).toEqual({ plan: "the plan" });
    expect(run.steps.implement!.feedback).toMatch(/use the new API/);
    expect(run.after.retro!.status).toBe("pending");
    expect(run.history.at(-1)).toMatchObject({ type: "run_restarted", stepId: "implement" });
    expect(fx.notes.join(" ")).toMatch(/restarted from "implement"/);

    // The new attempt receives the kept outputs and the comment.
    const agentId = `a-implement-${clock}`;
    const started = startAttempt(run, "implement", { agentId, brief: "", now: now(), readonlySnapshot: null });
    expect(started.attempt.n).toBe(2);
    expect(started.attempt.inputs.plan!.value).toBe("the plan");
    expect(started.prompt).toMatch(/Restarted from this step by a human: use the new API/);
    completeStep(run, "implement", { outcome: "success", now: now() });
    step(run, "review");
    expect(run.status).toBe("completed");
    expect(run.after.retro!.status).toBe("running");
  });

  it("puts back unfinished parallel steps, and rewinds everything after an earlier step", async () => {
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "p" });
    begin(run, "implement");
    begin(run, "docs");
    cancelRun(run, "stop", now());
    restartRun(run, "implement", { comment: null, by: null, now: now() });
    // docs was cut short by the cancel: it is ready again too.
    expect(readySteps(run).sort()).toEqual(["docs", "implement"]);
    expect(run.steps.implement!.feedback).toBeNull();

    cancelRun(run, "again", now());
    restartRun(run, "investigate", { comment: null, by: null, now: now() });
    expect(readySteps(run)).toEqual(["investigate"]);
    expect(run.steps.investigate!.outputs).toEqual({});
    expect(run.steps.implement!.status).toBe("pending");
  });

  it("restarts a failed run whose after-tasks already ran: they are pending again", async () => {
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "p" });
    step(run, "implement", "give_up");
    expect(run.status).toBe("failed");
    expect(run.after.retro!.status).toBe("running");
    step(run, "retro");
    expect(run.after.retro!.status).toBe("completed");

    restartRun(run, "implement", { comment: null, by: null, now: now() });
    expect(run.status).toBe("running");
    expect(run.after.retro).toEqual({ status: "pending", startedAt: null, endedAt: null, detail: null });
    expect(readySteps(run).sort()).toEqual(["docs", "implement"]);
  });

  it("refuses active runs, steps whose needs did not complete and after-task steps; unarchives an archived run", async () => {
    const run = start(await playbook());
    expect(restartBlocker(run, "investigate")).toMatch(/only a finished run/);
    step(run, "investigate", "success", { plan: "p" });
    begin(run, "implement");
    cancelRun(run, "stop", now());
    expect(restartBlocker(run, "review")).toMatch(/needs implement, docs/);
    expect(() => restartRun(run, "review", { comment: null, by: null, now: now() })).toThrow(/needs implement, docs/);
    expect(restartBlocker(run, "retro")).toMatch(/after-task/);
    expect(restartBlocker(run, "docs")).toBeNull();
    run.archivedAt = now();
    run.seenAt = now();
    expect(restartBlocker(run, "docs")).toBeNull();
    restartRun(run, "docs", { comment: null, by: null, now: now() });
    expect(run.archivedAt).toBeNull();
    expect(run.seenAt).toBeNull();
  });
});

/** Just enough of the daemon API for Runtime.restartRun. */
function fakePaseo(agents: Record<string, { archivedAt: string | null; status?: string }>, gone: string[] = []) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ workspaceId: string; labels: Record<string, string> }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => (agents[agentId] ? { agent: { id: agentId, status: "idle", provider: "claude", model: null, ...agents[agentId] } } : null),
    send: async (text: string) => {
      sent.push({ agentId, text });
    },
    reload: async () => null,
    // Recently active: no silence reminder in these tests.
    timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message" }, timestamp: new Date().toISOString() }] }) },
  });
  const paseo = {
    agents: { ref },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => (gone.includes(workspaceId) ? null : { id: workspaceId, projectId: workspaceId === "foreign" ? "other" : "p", workspaceDirectory: tmpdir() }),
        agents: {
          create: async (input: { labels: Record<string, string> }) => {
            const id = `mgr-${created.length + 1}`;
            created.push({ workspaceId, labels: input.labels });
            agents[id] = { archivedAt: null };
            return { id, ...ref(id) };
          },
        },
      }),
    },
  };
  return { paseo, sent, created };
}

describe("Runtime.restartRun", () => {
  async function stored(archivedManager: boolean, failure?: string, gone: string[] = []) {
    const dir = await mkdtemp(path.join(tmpdir(), "restart-store-"));
    temps.push(dir);
    const store = new RunStore(dir);
    await store.init();
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "p" });
    begin(run, "implement");
    if (failure) failRun(run, failure, now());
    else cancelRun(run, "stop", now());
    if (archivedManager) run.archivedAt = now();
    await store.create(run);
    const fake = fakePaseo({ m: { archivedAt: archivedManager ? now() : null } }, gone);
    const runtime = new Runtime(store);
    runtimes.push(runtime);
    await runtime.attach(fake.paseo as never);
    return { store, runtime, ...fake };
  }

  it("hands a run whose manager was archived to a new Playbook Manager in its workspace", async () => {
    const { store, runtime, sent, created } = await stored(true);
    const result = await runtime.restartRun("run_r", "implement", "API fixed", "agent-x", "agent");
    expect(result.newManager).toBe(true);
    expect(created).toEqual([{ workspaceId: "ws", labels: { "playbooks/manager": "true" } }]);
    const run = store.get("run_r")!;
    expect(run).toMatchObject({ status: "running", managerAgentId: "mgr-1", archivedAt: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("mgr-1");
    expect(sent[0]!.text).toMatch(/You are now the Playbook Manager of run run_r/);
    expect(sent[0]!.text).toMatch(/Agent agent-x restarted the run from "implement": "API fixed"/);
    expect(runtime.ownedRun("mgr-1", "run_r").id).toBe("run_r");
  });

  it("marks a finished run seen once, and leaves an active run unseen", async () => {
    const { store, runtime } = await stored(false);
    const seenAt = await runtime.markSeen("run_r");
    expect(seenAt).not.toBeNull();
    expect(await runtime.markSeen("run_r")).toBe(seenAt);
    await runtime.restartRun("run_r", "implement", null, "laptop");
    expect(store.get("run_r")!.seenAt).toBeNull();
    expect(await runtime.markSeen("run_r")).toBeNull();
  });

  it("keeps a manager that still exists and wakes it", async () => {
    const { store, runtime, sent, created } = await stored(false);
    const result = await runtime.restartRun("run_r", "implement", null, "laptop");
    expect(result.newManager).toBe(false);
    expect(created).toEqual([]);
    expect(store.get("run_r")!.managerAgentId).toBe("m");
    expect(sent.map((entry) => entry.agentId)).toEqual(["m"]);
    expect(sent[0]!.text).toMatch(/A human \(laptop\) restarted the run from "implement" via the panel/);
  });

  it("lets another agent of the workspace take over a run that failed with \"manager lost\", without repeating finished steps", async () => {
    const { store, runtime, sent, created } = await stored(true, "manager lost (archived)");
    expect(runListing(store.get("run_r")!)).toMatchObject({ failure: "manager lost (archived)", restartableFrom: ["investigate", "implement", "docs"] });
    const result = await runtime.restartRun("run_r", "implement", null, "agent-y", "agent", { id: "agent-y", workspaceId: "ws" });
    expect(result.newManager).toBe(true);
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
    const run = store.get("run_r")!;
    expect(run).toMatchObject({ status: "running", managerAgentId: "agent-y", archivedAt: null, failure: null });
    expect(run.steps.investigate).toMatchObject({ status: "completed", outputs: { plan: "p" } });
    expect(readySteps(run).sort()).toEqual(["docs", "implement"]);
    expect(runtime.ownedRun("agent-y", "run_r").id).toBe("run_r");
  });

  it("moves a \"manager lost\" run whose workspace was deleted to another workspace, keeping earlier outputs", async () => {
    const { store, runtime, sent, created } = await stored(true, "manager lost (archived)", ["ws"]);
    await expect(runtime.restartRun("run_r", "implement", null, "agent-x", "agent")).rejects.toThrow(/no longer exists.*Pass workspaceId/);
    const result = await runtime.restartRun("run_r", "implement", null, "agent-x", "agent", undefined, "ws2");
    expect(result.newManager).toBe(true);
    expect(created).toEqual([{ workspaceId: "ws2", labels: { "playbooks/manager": "true" } }]);
    const run = store.get("run_r")!;
    expect(run).toMatchObject({ status: "running", workspaceId: "ws2", managerAgentId: "mgr-1", failure: null });
    expect(run.steps.investigate).toMatchObject({ status: "completed", outputs: { plan: "p" } });
    expect(run.history.some((entry) => entry.type === "run_moved")).toBe(true);
    expect(sent[0]!.agentId).toBe("mgr-1");
    expect(sent[0]!.text).toMatch(/restarted in workspace ws2/);
  });

  it("names the active run of a busy workspace and suggests workspaceId; refuses a busy or foreign target", async () => {
    const { store, runtime } = await stored(false);
    const other = start(await playbook());
    other.id = "run_busy";
    other.workspaceId = "ws";
    await store.create(other);
    await expect(runtime.restartRun("run_r", "implement", null, "laptop")).rejects.toThrow(/another active run \(run_busy\).*Pass workspaceId/);
    const third = start(await playbook());
    third.id = "run_third";
    third.workspaceId = "ws3";
    await store.create(third);
    await expect(runtime.restartRun("run_r", "implement", null, "laptop", "panel", undefined, "ws3")).rejects.toThrow(/workspace ws3 already has an active run \(run_third\)/);
    await expect(runtime.restartRun("run_r", "implement", null, "laptop", "panel", undefined, "foreign")).rejects.toThrow(/another project/);
    await expect(runtime.restartRun("run_r", "implement", null, "laptop", "panel", undefined, "ws2")).resolves.toMatchObject({ newManager: true });
    expect(store.get("run_r")!.workspaceId).toBe("ws2");
  });

  it("refuses a takeover from an agent of another workspace", async () => {
    const { store, runtime } = await stored(false);
    await expect(runtime.restartRun("run_r", "implement", null, "agent-z", "agent", { id: "agent-z", workspaceId: "other" })).rejects.toThrow(/only an agent of that workspace/);
    expect(store.get("run_r")).toMatchObject({ status: "canceled", managerAgentId: "m" });
  });
});

describe("a manager archived with the agent that created it", () => {
  async function activeRun(parentArchived: boolean) {
    const dir = await mkdtemp(path.join(tmpdir(), "restart-store-"));
    temps.push(dir);
    const store = new RunStore(dir);
    await store.init();
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "p" });
    const implementer = begin(run, "implement");
    await store.create(run);
    const agents = { m: { archivedAt: null as string | null }, coordinator: { archivedAt: null as string | null }, [implementer]: { archivedAt: null as string | null, status: "running" } };
    const fake = fakePaseo(agents);
    const runtime = new Runtime(store);
    runtimes.push(runtime);
    await runtime.attach(fake.paseo as never);
    // Archived after the plugin started: by Paseo's cascade from the coordinator, or on its own.
    if (parentArchived) agents.coordinator.archivedAt = now();
    agents.m.archivedAt = now();
    agents[implementer]!.archivedAt = now();
    return { store, runtime, implementer, ...fake };
  }

  it("hands the active run to a new Playbook Manager instead of failing it; finished steps are kept", async () => {
    const { store, runtime, sent, created, implementer } = await activeRun(true);
    await runtime.onAgentArchived("m", "coordinator");
    let run = store.get("run_r")!;
    expect(created).toEqual([{ workspaceId: "ws", labels: { "playbooks/manager": "true" } }]);
    expect(run).toMatchObject({ status: "running", managerAgentId: "mgr-1", archivedAt: null, failure: null });
    expect(run.steps.investigate).toMatchObject({ status: "completed", outputs: { plan: "p" } });
    expect(run.history.at(-1)).toMatchObject({ type: "manager_replaced" });
    expect(sent[0]!.agentId).toBe("mgr-1");
    expect(sent[0]!.text).toMatch(/You are now the Playbook Manager of run run_r/);
    expect(sent[0]!.text).toMatch(/archived too: implement/);

    // The step agent went with it (Paseo's cascade): the new manager hears it ended lost.
    await runtime.onAgentArchived(implementer, "m");
    run = store.get("run_r")!;
    expect(run.steps.implement!.status).toBe("reported");
    expect(sent.at(-1)).toMatchObject({ agentId: "mgr-1" });
    expect(sent.at(-1)!.text).toMatch(/"implement" attempt 1 ended \(lost\)/);
  });

  it("tells the new manager about steps whose agents were archived first", async () => {
    const { runtime, sent, implementer } = await activeRun(true);
    await runtime.onAgentArchived(implementer, "m");
    await runtime.onAgentArchived("m", "coordinator");
    const takeover = sent.find((entry) => entry.agentId === "mgr-1")!;
    expect(takeover.text).toMatch(/Steps waiting for complete_step: implement/);
  });

  it("still fails the run when the manager itself was archived, records the cause and tells the agent that created it", async () => {
    const { store, runtime, created, sent } = await activeRun(false);
    await runtime.onAgentArchived("m", "coordinator");
    expect(created).toEqual([]);
    const run = store.get("run_r")!;
    expect(run).toMatchObject({ status: "failed", failure: "manager lost (archived)" });
    const cause = run.history.find((entry) => entry.type === "manager_archived")!;
    expect(cause.detail).toMatch(/manager m was archived; the host does not say by whom.*parent coordinator is still active.*workspace ws still exists/);
    expect(run.history.indexOf(cause)).toBeLessThan(run.history.findIndex((entry) => entry.type === "run_failed"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("coordinator");
    expect(sent[0]!.text).toMatch(/Run run_r .* failed: manager lost \(archived\)\. Steps? reached: implement\..*restart_run\(\{ runId: "run_r", stepId: "implement" \}\).*restartableFrom: investigate, implement, docs/);
  });

  it("notes the other managers archived in the same second", async () => {
    const { store, runtime } = await activeRun(false);
    const other = start(await playbook());
    other.id = "run_other";
    other.workspaceId = "ws9";
    other.managerAgentId = "m2";
    await store.create(other);
    await runtime.onAgentArchived("m2", "coordinator");
    await runtime.onAgentArchived("m", "coordinator");
    expect(store.get("run_r")!.history.find((entry) => entry.type === "manager_archived")!.detail).toMatch(/other managers archived within 2 s: m2/);
  });
});

describe("Runtime.startAfterTask", () => {
  async function stored() {
    const dir = await mkdtemp(path.join(tmpdir(), "after-store-"));
    temps.push(dir);
    const store = new RunStore(dir);
    await store.init();
    const run = start(await playbook());
    cancelRun(run, "stop", now());
    await store.create(run);
    const fake = fakePaseo({ m: { archivedAt: null } });
    const runtime = new Runtime(store);
    runtimes.push(runtime);
    await runtime.attach(fake.paseo as never);
    return { store, runtime, ...fake };
  }

  it("wakes the manager when another agent starts a manual after-task at the human's request", async () => {
    const { store, runtime, sent } = await stored();
    const run = await runtime.startAfterTask("run_r", "notify", "agent-x");
    expect(run.after.notify?.status).toBe("running");
    expect(readySteps(store.get("run_r")!)).toEqual(["notify"]);
    expect(runListing(run).after).toEqual([
      { id: "retro", title: "Retro", trigger: "auto", status: "canceled" },
      { id: "notify", title: "Notify", trigger: "manual", status: "running" },
    ]);
    expect(sent.map((entry) => entry.agentId)).toEqual(["m"]);
    expect(sent[0]!.text).toMatch(/Agent agent-x started the after-task "notify" at the human's request/);
  });

  it("does not wake the manager when it starts the task itself", async () => {
    const { runtime, sent } = await stored();
    await runtime.startAfterTask("run_r", "notify", "m");
    expect(sent).toEqual([]);
    await expect(runtime.startAfterTask("run_r", "notify", "m")).rejects.toThrow(/runs once/);
    await expect(runtime.startAfterTask("run_r", "retro", "m")).rejects.toThrow(/trigger: auto/);
  });
});
