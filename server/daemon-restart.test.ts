import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRun, recordReport, endTurn, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const now = () => new Date().toISOString();

type AgentState = { status: string; archivedAt?: string | null; sendFails?: boolean };

/** Just enough of the daemon API, as it looks after a restart: agents by id, with a status. */
function fakePaseo(agents: Record<string, AgentState>) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => {
      const agent = agents[agentId];
      return agent ? { agent: { id: agentId, status: agent.status, provider: "claude", model: null, archivedAt: agent.archivedAt ?? null } } : null;
    },
    send: async (text: string) => {
      if (agents[agentId]?.sendFails) throw new Error("session gone");
      sent.push({ agentId, text });
    },
    reload: async () => null,
    archive: async () => undefined,
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  return { paseo: { agents: { ref } }, sent };
}

/** A two-step run (investigate → implement) whose manager is "m", restarted with these agents. */
async function restarted(prepare: (run: ReturnType<typeof newRun>) => void, agents: Record<string, AgentState>) {
  const dir = await mkdtemp(path.join(tmpdir(), "daemon-restart-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(
    path.join(root, "two.yaml"),
    "steps:\n  - id: investigate\n    role: investigator\n    outputs: { plan: {} }\n  - id: implement\n    role: implementer\n    needs: [investigate]\n    outputs: { pr: {} }\n",
  );
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "two")!.playbook!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_d", playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
  prepare(run);
  await store.create(run);
  const fake = fakePaseo({ m: { status: "idle" }, ...agents });
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { store, ...fake };
}

describe("after a daemon restart", () => {
  it("asks a step agent whose turn was cut to carry on in the same conversation", async () => {
    const { store, sent } = await restarted(
      (run) => startAttempt(run, "investigate", { agentId: "step-1", brief: "", now: now(), readonlySnapshot: null }),
      { "step-1": { status: "idle" } },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "step-1" });
    expect(sent[0]!.text).toMatch(/daemon restarted and cut your turn on step "investigate"/);
    const run = store.get("run_d")!;
    expect(run.steps.investigate).toMatchObject({ status: "running" });
    expect(run.steps.investigate!.attempts).toHaveLength(1);
    expect(run.history.at(-1)).toMatchObject({ type: "step_resumed", stepId: "investigate" });
  });

  it("leaves a step agent that is still running alone", async () => {
    const { store, sent } = await restarted(
      (run) => startAttempt(run, "investigate", { agentId: "step-1", brief: "", now: now(), readonlySnapshot: null }),
      { "step-1": { status: "running" } },
    );
    expect(sent).toEqual([]);
    expect(store.get("run_d")!.steps.investigate!.status).toBe("running");
  });

  it("treats a step as lost when its agent is gone, archived, or cannot be resumed", async () => {
    const cases: Array<Record<string, AgentState>> = [{}, { "step-1": { status: "idle", archivedAt: now() } }, { "step-1": { status: "idle", sendFails: true } }];
    for (const agents of cases) {
      const { store, sent } = await restarted(
        (run) => startAttempt(run, "investigate", { agentId: "step-1", brief: "", now: now(), readonlySnapshot: null }),
        agents,
      );
      expect(store.get("run_d")!.steps.investigate!.attempts[0]!.turnEnd).toBe("lost");
      expect(sent.at(-1)).toMatchObject({ agentId: "m" });
      expect(sent.at(-1)!.text).toMatch(/"investigate" attempt 1 ended \(lost\)/);
      expect(sent.at(-1)!.text).not.toMatch(/daemon restarted/);
    }
  });

  it("wakes an idle manager whose run waits on it, once", async () => {
    const { sent } = await restarted((run) => {
      startAttempt(run, "investigate", { agentId: "step-1", brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, "step-1", { outcome: "success", summary: "done", outputs: { plan: "p" } }, now());
      endTurn(run, "step-1", { turnEnd: "completed", lastMessage: null, now: now() });
      // The manager had read that wake-up when the daemon stopped.
      run.inbox = [];
    }, { "step-1": { status: "idle" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "m" });
    expect(sent[0]!.text).toMatch(/daemon restarted and may have cut your last turn/);
    expect(sent[0]!.text).toMatch(/Waiting for complete_step: investigate/);
  });

  it("does not wake a manager that is busy, paused, or waiting on a running step", async () => {
    const reported = (run: ReturnType<typeof newRun>) => {
      startAttempt(run, "investigate", { agentId: "step-1", brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, "step-1", { outcome: "success", summary: "done", outputs: { plan: "p" } }, now());
      endTurn(run, "step-1", { turnEnd: "completed", lastMessage: null, now: now() });
      run.inbox = [];
    };
    const busy = await restarted(reported, { m: { status: "running" }, "step-1": { status: "idle" } });
    expect(busy.sent).toEqual([]);
    const paused = await restarted((run) => {
      reported(run);
      run.pausedAt = now();
    }, { "step-1": { status: "idle" } });
    expect(paused.sent).toEqual([]);
    const running = await restarted(
      (run) => startAttempt(run, "investigate", { agentId: "step-1", brief: "", now: now(), readonlySnapshot: null }),
      { "step-1": { status: "running" } },
    );
    expect(running.sent).toEqual([]);
  });
});
