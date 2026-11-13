import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRun, startAttempt } from "./engine";
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

const DEFAULTS = `tiers:
  cheap:
    - { provider: claude, model: claude-haiku-5-5 }
    - { provider: codex, model: gpt-5-mini }
`;
const PLAYBOOK = `
title: Release
steps:
  - id: release
    retries: 1
    role: { name: implementer, agent: { tier: cheap } }
    outputs: { pr: {} }
`;

/** The daemon API a failover touches: agents are created, briefed and archived; the failed one's timeline holds `errorText`. */
function fakePaseo(errorText: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ config: { provider?: string }; title: string }> = [];
  const archived: string[] = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: agentId === "m" ? "idle" : "running", provider: "claude", model: null, archivedAt: null } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => void archived.push(agentId),
    timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "working" } }, { item: { type: "error", message: errorText } }] }) },
  });
  const workspace = {
    agents: {
      create: async (input: { config: { provider?: string }; title: string }) => {
        created.push(input);
        return { id: `step-${created.length + 1}`, send: async (text: string) => void sent.push({ agentId: `step-${created.length + 1}`, text }) };
      },
    },
  };
  return { paseo: { agents: { ref }, workspaces: { ref: () => workspace } }, sent, created, archived };
}

async function setup(errorText: string, providers = "") {
  const dir = await mkdtemp(path.join(tmpdir(), "failover-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "defaults/main.yaml"), DEFAULTS + providers);
  await writeFile(path.join(root, "release.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "release")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
  startAttempt(run, "release", { agentId: "step-1", brief: "Ship it", now: new Date().toISOString(), readonlySnapshot: null });
  run.steps.release!.attempts[0]!.target = "claude/claude-haiku-5-5";
  await store.create(run);
  const fake = fakePaseo(errorText);
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { store, runtime, ...fake };
}

describe("provider fallback", () => {
  it("restarts the same attempt on the next target when the provider is out of tokens", async () => {
    const { store, runtime, created, sent, archived } = await setup("You've hit your usage limit. Try again at 3pm.");
    await runtime.onTurnEnded("step-1", "failed");
    expect(created).toHaveLength(1);
    expect(created[0]!.config.provider).toBe("codex/gpt-5-mini");
    const run = store.get("run_x")!;
    const state = run.steps.release!;
    expect(state.status).toBe("running");
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ agentId: "step-2", target: "codex/gpt-5-mini", endedAt: null });
    expect(run.exhausted.map((entry) => entry.target)).toEqual(["claude/claude-haiku-5-5"]);
    expect(run.history.some((entry) => entry.type === "provider_exhausted" && /claude\/claude-haiku-5-5 is out of tokens/.test(entry.detail))).toBe(true);
    expect(archived).toEqual(["step-1"]);
    // the new agent gets the same prompt; the manager is told, and no retry was used
    expect(sent.find((entry) => entry.agentId === "step-2")!.text).toMatch(/Ship it/);
    // Informational: the manager is not woken for a failover (the step history has it).
    expect(sent.find((entry) => entry.agentId === "m")).toBeUndefined();
  });

  it("leaves the failure to the manager when every target is out of tokens", async () => {
    const { store, runtime, created, sent } = await setup("rate limit exceeded");
    await runtime.onTurnEnded("step-1", "failed");
    expect(created).toHaveLength(1);
    // the second agent's provider runs out too
    await runtime.onTurnEnded("step-2", "failed");
    expect(created).toHaveLength(1);
    expect(store.get("run_x")!.exhausted.map((entry) => entry.target)).toEqual(["claude/claude-haiku-5-5", "codex/gpt-5-mini"]);
    expect(store.get("run_x")!.steps.release!.status).not.toBe("running");
    await runtime.onManagerTurnEnded("m");
    expect(sent.at(-1)!.agentId).toBe("m");
    expect(sent.at(-1)!.text).toMatch(/ended \(failed\) without reporting/);
  });

  it("does not move on for other failures", async () => {
    const { store, runtime, created } = await setup("TypeError: cannot read properties of undefined");
    await runtime.onTurnEnded("step-1", "failed");
    expect(created).toHaveLength(0);
    expect(store.get("run_x")!.exhausted).toEqual([]);
    expect(store.get("run_x")!.steps.release!.attempts[0]!.agentId).toBe("step-1");
  });

  const WAIT = "providers: { exhausted_for: 1h, on_exhausted: wait }\n";
  const wakeUp = (runtime: Runtime) => (runtime as unknown as { onWaitEnded: (runId: string, stepId: string, agentId: string) => Promise<void> }).onWaitEnded("run_x", "release", "step-2");

  it("waits for a provider to recover when every target is out of tokens and on_exhausted is wait", async () => {
    const { store, runtime, created, sent } = await setup("rate limit exceeded", WAIT);
    await runtime.onTurnEnded("step-1", "failed");
    await runtime.onTurnEnded("step-2", "failed");
    const state = store.get("run_x")!.steps.release!;
    expect(state.status).toBe("running");
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]!.waiting).not.toBeNull();
    expect(created).toHaveLength(1);
    await runtime.onManagerTurnEnded("m");
    expect(sent.some((message) => /waits and restarts the attempt/.test(message.text))).toBe(true);
    // the cooldown passes: the same attempt restarts on the first target that is back
    await store.mutate("run_x", (run) => {
      run.exhausted = run.exhausted.map((entry) => ({ ...entry, at: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
    });
    await wakeUp(runtime);
    expect(created).toHaveLength(2);
    expect(created[1]!.config.provider).toBe("claude/claude-haiku-5-5");
    const after = store.get("run_x")!.steps.release!;
    expect(after.status).toBe("running");
    expect(after.attempts[0]!.waiting).toBeNull();
    expect(after.attempts[0]!.agentId).toBe("step-3");
  });

  it("waits again when the targets are still out at wake-up", async () => {
    const { store, runtime, created } = await setup("rate limit exceeded", WAIT);
    await runtime.onTurnEnded("step-1", "failed");
    await runtime.onTurnEnded("step-2", "failed");
    await wakeUp(runtime);
    expect(created).toHaveLength(1);
    expect(store.get("run_x")!.steps.release!.attempts[0]!.waiting).not.toBeNull();
  });

  it("fails to the manager once max_wait is spent", async () => {
    const { store, runtime, sent } = await setup("rate limit exceeded", "providers: { on_exhausted: wait, max_wait: 30m }\n");
    await runtime.onTurnEnded("step-1", "failed");
    await runtime.onTurnEnded("step-2", "failed");
    expect(store.get("run_x")!.steps.release!.attempts[0]!.waiting).not.toBeNull();
    await store.mutate("run_x", (run) => {
      const waiting = run.steps.release!.attempts[0]!.waiting!;
      waiting.since = new Date(Date.now() - 31 * 60_000).toISOString();
    });
    await wakeUp(runtime);
    expect(store.get("run_x")!.steps.release!.status).not.toBe("running");
    await runtime.onManagerTurnEnded("m");
    expect(sent.at(-1)!.text).toMatch(/ended \(failed\) without reporting/);
  });

  it("does not wait by default", async () => {
    const { store } = await setup("rate limit exceeded");
    expect(store.get("run_x")!.playbook.onExhausted).toBe("fail");
    expect(store.get("run_x")!.playbook.maxWaitMs).toBeNull();
  });

  const pick = async (runtime: Runtime, store: RunStore) =>
    (await (runtime as unknown as { stepAgentConfig: (run: unknown, step: unknown) => Promise<{ provider: string }> }).stepAgentConfig(
      store.get("run_x")!,
      store.get("run_x")!.playbook.steps[0]!,
    )).provider;
  const markedAgo = (ms: number) => ({ target: "claude/claude-haiku-5-5", at: new Date(Date.now() - ms).toISOString() });

  it("skips an exhausted target until exhausted_for has passed, then picks it again", async () => {
    const { store, runtime } = await setup("rate limit exceeded");
    expect(store.get("run_x")!.playbook.exhaustedForMs).toBe(3_600_000);
    await store.mutate("run_x", (run) => void run.exhausted.push(markedAgo(59 * 60_000)));
    expect(await pick(runtime, store)).toBe("codex/gpt-5-mini");
    await store.mutate("run_x", (run) => void (run.exhausted = [markedAgo(61 * 60_000)]));
    expect(await pick(runtime, store)).toBe("claude/claude-haiku-5-5");
  });

  it("replaces an expired entry with a fresh time when the target fails again", async () => {
    const { store, runtime, created } = await setup("rate limit exceeded");
    await store.mutate("run_x", (run) => void (run.exhausted = [markedAgo(2 * 3_600_000)]));
    await runtime.onTurnEnded("step-1", "failed");
    expect(created[0]!.config.provider).toBe("codex/gpt-5-mini");
    const entries = store.get("run_x")!.exhausted.filter((entry) => entry.target === "claude/claude-haiku-5-5");
    expect(entries).toHaveLength(1);
    expect(Date.now() - Date.parse(entries[0]!.at)).toBeLessThan(60_000);
  });

  it("reads run files whose exhausted entries are bare strings", async () => {
    const { store } = await setup("x");
    const old = JSON.parse(JSON.stringify(store.get("run_x")!));
    old.exhausted = ["claude/claude-haiku-5-5"];
    const { RunSchema } = await import("../shared/types");
    const run = RunSchema.parse(old);
    expect(run.exhausted).toHaveLength(1);
    expect(run.exhausted[0]!.target).toBe("claude/claude-haiku-5-5");
    expect(Date.now() - Date.parse(run.exhausted[0]!.at)).toBeLessThan(60_000);
  });

  it("reads run files written before `exhausted` existed", async () => {
    const { store } = await setup("x");
    const { exhausted: _omit, ...old } = JSON.parse(JSON.stringify(store.get("run_x")!));
    const { RunSchema } = await import("../shared/types");
    expect(RunSchema.parse(old).exhausted).toEqual([]);
  });
});
