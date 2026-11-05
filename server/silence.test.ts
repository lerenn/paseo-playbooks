import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttemptSchema } from "../shared/types";
import { EngineError, newRun, reopenAttempt, startAttempt } from "./engine";
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

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Just enough of the daemon API: the step agent "step-1" runs; its newest timeline entry is at `activity`. */
function fakePaseo(state: { activity: string | null; stepStatus?: string }) {
  const sent: Array<{ agentId: string; text: string; options?: unknown }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: agentId === "m" ? "idle" : state.stepStatus ?? "running", provider: "claude", model: null, archivedAt: null } }),
    send: async (text: string, options?: unknown) => {
      sent.push({ agentId, text, options });
    },
    reload: async () => null,
    timeline: { refetch: async () => ({ entries: state.activity ? [{ item: { type: "assistant_message", text: "working" }, timestamp: state.activity }] : [] }) },
  });
  return { paseo: { agents: { ref } }, sent };
}

async function setup(options: { step?: string; startedAgo: number; activity?: string | null; stepStatus?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "silence-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "release.yaml"), `steps:\n  - id: release\n    role: implementer\n    outputs: { pr: {} }\n${options.step ?? ""}`);
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "release")!.playbook!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: ago(options.startedAgo) });
  startAttempt(run, "release", { agentId: "step-1", brief: "", now: ago(options.startedAgo), readonlySnapshot: null });
  await store.create(run);
  const state = { activity: options.activity === undefined ? null : options.activity, stepStatus: options.stepStatus };
  const fake = fakePaseo(state);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { store, runtime, state, ...fake };
}

describe("a running step that goes silent", () => {
  it("is asked once to report or say what it waits for, and the manager is told", async () => {
    const { store, runtime, sent } = await setup({ startedAgo: 40 * MIN, activity: ago(35 * MIN) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({ agentId: "step-1", options: { activeTurnBehavior: "steer" } });
    expect(sent[0]!.text).toMatch(/has shown no activity for 35 min/);
    expect(sent[0]!.text).toMatch(/call report_step_result now/);
    expect(sent[0]!.text).toMatch(/say in one line what you are waiting for/);
    expect(sent[1]!.agentId).toBe("m");
    expect(sent[1]!.text).toMatch(/"release" attempt 1 is still running and it has shown no activity for 35 min/);
    expect(store.get("run_x")!.steps.release!.attempts[0]!.silenceReminded).toBe(true);

    // Only once per attempt.
    await runtime.checkSilence("run_x", "release", "step-1");
    expect(sent).toHaveLength(2);
    expect(store.get("run_x")!.steps.release!.status).toBe("running");
  });

  it("is left alone while it shows activity, or when silence is off", async () => {
    const active = await setup({ startedAgo: 40 * MIN, activity: ago(2 * MIN) });
    await active.runtime.checkSilence("run_x", "release", "step-1");
    expect(active.sent).toEqual([]);
    expect(active.store.get("run_x")!.steps.release!.attempts[0]!.silenceReminded).toBe(false);

    const off = await setup({ step: "    silence: off\n", startedAgo: 5 * 60 * MIN, activity: null });
    await off.runtime.checkSilence("run_x", "release", "step-1");
    expect(off.sent).toEqual([]);
  });

  it("is not reminded once its turn has ended; the turn-end hook handles it", async () => {
    const { runtime, sent } = await setup({ startedAgo: 40 * MIN, activity: null, stepStatus: "idle" });
    await runtime.checkSilence("run_x", "release", "step-1");
    // Attaching reconciles as after a restart, which asks the idle agent to carry on; no silence reminder follows.
    expect(sent.filter((entry) => entry.agentId === "step-1" && !/daemon restarted/.test(entry.text))).toEqual([]);
  });

  it("is reminded shortly before its timeout, even while active", async () => {
    const { sent } = await setup({ step: "    timeout: 30m\n", startedAgo: 28 * MIN, activity: ago(MIN) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]!.text).toMatch(/The timeout of step "release" fires in about 2 min/);
    expect(sent[1]!.text).toMatch(/its timeout fires in about 2 min/);
  });
});

describe("nudge_step on a timed-out step", () => {
  it("reopens the attempt: the agent's next report replaces the timeout failure", async () => {
    const { store, runtime, sent } = await setup({ step: "    timeout: 1h\n", startedAgo: 2 * 60 * MIN, activity: ago(MIN) });
    await vi.waitFor(() => expect(store.get("run_x")!.steps.release!.status).toBe("reported"));
    let attempt = store.get("run_x")!.steps.release!.attempts[0]!;
    expect(attempt).toMatchObject({ turnEnd: "timeout", report: { outcome: "failure", summary: "timed out after 60 min" } });
    expect(sent.at(-1)!.text).toMatch(/its report replaces the timeout failure/);
    await runtime.onTurnEnded("m", "completed");

    await runtime.nudgeStep("run_x", "release", "Your PR is merged: report it.");
    attempt = store.get("run_x")!.steps.release!.attempts[0]!;
    expect(store.get("run_x")!.steps.release!.status).toBe("running");
    expect(attempt).toMatchObject({ report: null, endedAt: null, turnEnd: null });
    expect(attempt.reopenedAt).not.toBeNull();
    expect(store.get("run_x")!.history.at(-1)).toMatchObject({ type: "step_reopened", detail: "attempt 1, after its timeout" });

    // Its timeout counts again from the nudge: it does not fire at once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.get("run_x")!.steps.release!.status).toBe("running");

    await runtime.report("step-1", { outcome: "success", summary: "merged", outputs: { pr: "https://x/pr/1" } });
    await runtime.onTurnEnded("step-1", "completed");
    expect(store.get("run_x")!.steps.release!.attempts[0]!.report).toMatchObject({ outcome: "success", summary: "merged" });
    expect(sent.at(-1)).toMatchObject({ agentId: "m" });
    expect(sent.at(-1)!.text).toMatch(/reported success: merged/);
  });

  it("keeps the report of a step that was not timed out", async () => {
    const { store, runtime } = await setup({ startedAgo: MIN, activity: ago(0) });
    await runtime.report("step-1", { outcome: "success", summary: "done", outputs: { pr: "https://x/pr/1" } });
    await runtime.onTurnEnded("step-1", "completed");
    await runtime.nudgeStep("run_x", "release", "Add the changelog link.");
    expect(store.get("run_x")!.steps.release!.attempts[0]!.report).toMatchObject({ outcome: "success" });
  });
});

describe("reopenAttempt", () => {
  it("only reopens a reported step", async () => {
    const { store } = await setup({ startedAgo: MIN, activity: ago(0) });
    expect(() => reopenAttempt(structuredClone(store.get("run_x")!), "release", new Date().toISOString())).toThrow(EngineError);
  });

  it("reads run files written before silence reminders existed", () => {
    const attempt = { n: 1, agentId: "a", startedAt: "t", endedAt: null, brief: "", inputs: {}, report: null, lastMessage: null, outcome: null, turnEnd: null, readonlySnapshot: null };
    expect(AttemptSchema.parse(attempt)).toMatchObject({ silenceReminded: false, reopenedAt: null });
  });
});
