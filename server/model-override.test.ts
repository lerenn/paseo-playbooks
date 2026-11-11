import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRun, restartRun as engineRestart, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { runCompact, runFull } from "./tools";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const WEEKLY = "You've hit your weekly limit · resets Nov 16, 2pm (Europe/Paris)";
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const playbook = (agent: string) => `
title: Release
steps:
  - id: release
    retries: 1
    role: { name: implementer, agent: ${agent} }
    outputs: { pr: {} }
`;

/** The daemon API these paths touch; a step agent's last message is `lastText` (a turn that ended "completed", not "failed"). */
function fakePaseo(lastText: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ config: { provider?: string; modeId?: string; thinkingOptionId?: string }; title: string }> = [];
  const archived: string[] = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: agentId === "m" ? "idle" : "running", provider: "claude", model: null, archivedAt: null } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => void archived.push(agentId),
    timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: lastText } }] }) },
  });
  const workspace = {
    agents: {
      create: async (input: (typeof created)[number]) => {
        created.push(input);
        const id = `step-${created.length + 1}`;
        return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
      },
    },
  };
  const providers = {
    listModels: async (provider: string) =>
      provider === "claude"
        ? { provider, models: [{ id: "claude-opus-5-5", thinkingOptions: [{ id: "medium" }, { id: "high" }] }, { id: "claude-haiku-5-5" }] }
        : provider === "codex"
          ? { provider, models: [{ id: "gpt-5.5" }] }
          : { provider, models: [], error: `unknown provider ${provider}` },
  };
  return { paseo: { agents: { ref }, workspaces: { ref: () => workspace }, providers }, sent, created, archived };
}

async function setup(options: { agent?: string; defaults?: string; lastText?: string; started?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "model-override-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "defaults/main.yaml"), options.defaults ?? "");
  await writeFile(path.join(root, "release.yaml"), playbook(options.agent ?? "{ provider: claude, model: claude-haiku-5-5, mode: bypassPermissions }"));
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "release")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
  if (options.started !== false) {
    const now = new Date().toISOString();
    startAttempt(run, "release", { agentId: "step-1", brief: "Ship it", now, readonlySnapshot: null });
    const attempt = run.steps.release!.attempts[0]!;
    attempt.target = "claude/claude-haiku-5-5";
    attempt.agents.push({ agentId: "step-1", target: attempt.target, at: now, why: "chain" });
  }
  await store.create(run);
  const fake = fakePaseo(options.lastText ?? WEEKLY);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { store, runtime, ...fake };
}

describe("out of tokens on a completed turn", () => {
  it("fails over when the turn ends on the provider's limit notice (no reminder sent)", async () => {
    const { store, runtime, created, sent } = await setup({
      defaults: "tiers:\n  cheap:\n    - { provider: claude, model: claude-haiku-5-5 }\n    - { provider: codex, model: gpt-5.5 }\n",
      agent: "{ tier: cheap }",
    });
    await runtime.onTurnEnded("step-1", "completed");
    expect(created.map((input) => input.config.provider)).toEqual(["codex/gpt-5.5"]);
    const attempt = store.get("run_x")!.steps.release!.attempts[0]!;
    expect(attempt.agents.map((agent) => [agent.target, agent.why])).toEqual([
      ["claude/claude-haiku-5-5", "chain"],
      ["codex/gpt-5.5", "failover"],
    ]);
    expect(sent.some((entry) => entry.agentId === "step-1")).toBe(false);
  });

  it("falls back to providers.fallback when the role has a single target, without carrying its mode to another provider", async () => {
    const { store, runtime, created } = await setup({ defaults: "providers: { fallback: [codex/gpt-5.5, claude/claude-opus-5-5] }\n" });
    await runtime.onTurnEnded("step-1", "completed");
    expect(created).toHaveLength(1);
    expect(created[0]!.config.provider).toBe("codex/gpt-5.5");
    expect(created[0]!.config.modeId).toBeUndefined();
    expect(store.get("run_x")!.exhausted.map((entry) => entry.target)).toEqual(["claude/claude-haiku-5-5"]);
  });

  it("keeps the role's mode on a fallback of the same provider", async () => {
    const { runtime, created } = await setup({ defaults: "providers: { fallback: [claude/claude-opus-5-5] }\n" });
    await runtime.onTurnEnded("step-1", "completed");
    expect(created[0]!.config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" });
  });

  it("tells the manager to move the step when no fallback is left", async () => {
    const { store, runtime, created, sent } = await setup();
    await runtime.onTurnEnded("step-1", "completed");
    expect(created).toHaveLength(0);
    expect(store.get("run_x")!.steps.release!.status).toBe("reported");
    expect(sent.some((entry) => entry.agentId === "step-1")).toBe(false);
    await runtime.onManagerTurnEnded("m");
    const notice = sent.filter((entry) => entry.agentId === "m").at(-1)!.text;
    expect(notice).toMatch(/claude\/claude-haiku-5-5 is out of tokens/);
    expect(notice).toMatch(/nudge_step with model/);
  });

  it("does not take an agent's long text about rate limits for a limit notice", async () => {
    const long = `I added a backoff for the rate limit (HTTP 429) in the client. ${"More detail. ".repeat(50)}`;
    const { runtime, created, sent } = await setup({ lastText: long, defaults: "providers: { fallback: [codex/gpt-5.5] }\n" });
    await runtime.onTurnEnded("step-1", "completed");
    expect(created).toHaveLength(0);
    // the usual reminder to report
    expect(sent.some((entry) => entry.agentId === "step-1")).toBe(true);
  });
});

describe("the manager's model", () => {
  it("nudge_step with model moves the same attempt to a new agent on that model", async () => {
    const { store, runtime, created, sent, archived } = await setup();
    await runtime.onTurnEnded("step-1", "completed");
    const moved = await runtime.nudgeStep("run_x", "release", "Carry on from the last push.", false, { target: "claude/claude-opus-5-5", thinking: "high" });
    expect(moved).toEqual({ agentId: "step-2", target: "claude/claude-opus-5-5" });
    expect(created[0]!.config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high" });
    const state = store.get("run_x")!.steps.release!;
    expect(state.status).toBe("running");
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ agentId: "step-2", target: "claude/claude-opus-5-5", turnEnd: null, reminded: false });
    expect(state.attempts[0]!.agents.map((agent) => agent.why)).toEqual(["chain", "model"]);
    const brief = sent.find((entry) => entry.agentId === "step-2")!.text;
    expect(brief).toMatch(/A previous agent of this attempt \(agent step-1/);
    expect(brief).toMatch(/Carry on from the last push\./);
    expect(archived).toEqual(["step-1"]);
    // the old agent's late turn end changes nothing
    await runtime.onTurnEnded("step-1", "completed");
    expect(store.get("run_x")!.steps.release!.status).toBe("running");
  });

  it("refuses a model the provider does not list, and thinking without model", async () => {
    const { runtime, created } = await setup();
    await expect(runtime.nudgeStep("run_x", "release", "go", false, { target: "claude/claude-sonnet-9" })).rejects.toThrow(/has no model "claude-sonnet-9". It has: claude-opus-5-5, claude-haiku-5-5/);
    await expect(runtime.nudgeStep("run_x", "release", "go", false, { target: "nope/x" })).rejects.toThrow(/lists no models \(unknown provider nope\)/);
    await expect(runtime.nudgeStep("run_x", "release", "go", false, { target: "opus" })).rejects.toThrow(/expected provider\/model/);
    await expect(runtime.nudgeStep("run_x", "release", "go", false, { target: "claude/claude-opus-5-5", thinking: "ultra" })).rejects.toThrow(/offers medium, high/);
    expect(created).toHaveLength(0);
  });

  it("start_step with model runs that attempt on it", async () => {
    const { store, runtime, created } = await setup({ started: false });
    const started = await runtime.startStep("m", "run_x", "release", "", { target: "codex/gpt-5.5" });
    expect(started.target).toBe("codex/gpt-5.5");
    expect(created[0]!.config.provider).toBe("codex/gpt-5.5");
    expect(store.get("run_x")!.steps.release!.attempts[0]!.agents).toMatchObject([{ target: "codex/gpt-5.5", why: "model" }]);
  });

  it("start_step without model uses the role's model", async () => {
    const { store, runtime, created } = await setup({ started: false });
    await runtime.startStep("m", "run_x", "release", "");
    expect(created[0]!.config.provider).toBe("claude/claude-haiku-5-5");
    expect(store.get("run_x")!.steps.release!.attempts[0]!.agents).toMatchObject([{ target: "claude/claude-haiku-5-5", why: "chain" }]);
  });

  it("restart_run's model applies to the step's next attempt once", async () => {
    const { store, runtime, created } = await setup({ started: false });
    await store.mutate("run_x", (run) => {
      run.status = "failed";
      engineRestart(run, "release", { comment: null, by: null, now: new Date().toISOString(), model: { target: "claude/claude-opus-5-5" } });
    });
    expect(store.get("run_x")!.steps.release!.nextModel).toEqual({ target: "claude/claude-opus-5-5" });
    await runtime.startStep("m", "run_x", "release", "");
    expect(created[0]!.config.provider).toBe("claude/claude-opus-5-5");
    expect(store.get("run_x")!.steps.release!.nextModel).toBeNull();
  });

  it("get_run shows the model of each attempt", async () => {
    const { store, runtime } = await setup();
    await runtime.onTurnEnded("step-1", "completed");
    await runtime.nudgeStep("run_x", "release", "go", false, { target: "codex/gpt-5.5" });
    const run = store.get("run_x")!;
    expect(runCompact(run).steps.release).toMatchObject({ model: "codex/gpt-5.5" });
    const full = runFull(run).steps.release as unknown as { models: Array<{ attempt: number; agents: Array<{ target: string; why: string }> }> };
    expect(full.models).toMatchObject([{ attempt: 1, agents: [{ target: "claude/claude-haiku-5-5", why: "chain" }, { target: "codex/gpt-5.5", why: "model" }] }]);
  });
});
