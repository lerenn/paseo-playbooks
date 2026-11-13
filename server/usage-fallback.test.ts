import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function fakePaseo(errorText: string, listUsage?: () => Promise<unknown>) {
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
  return { paseo: { agents: { ref }, workspaces: { ref: () => workspace }, ...(listUsage ? { providers: { listUsage } } : {}) }, sent, created, archived };
}

async function setup(errorText: string, providers = "", listUsage?: () => Promise<unknown>) {
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
  const fake = fakePaseo(errorText, listUsage);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { store, runtime, ...fake };
}


const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const win = (id: string, usedPct: number, resetsAt: string | null = inHours(48)) => ({ id, label: id, usedPct, remainingPct: 100 - usedPct, resetsAt, runsOutAt: null, shortfallPct: 0, tone: "ok" });
const usage = (...providers: Array<{ providerId: string; windows: unknown[]; status?: string }>) => async () => ({
  requestId: "r",
  fetchedAt: new Date().toISOString(),
  providers: providers.map((entry) => ({ displayName: entry.providerId, status: "available", planLabel: null, fetchedAt: "", nextRefreshAt: null, ...entry })),
});

describe("usage-aware fallback", () => {
  const pick = async (runtime: Runtime, store: RunStore) =>
    (await (runtime as unknown as { stepAgentConfig: (run: unknown, step: unknown) => Promise<{ provider: string }> }).stepAgentConfig(
      store.get("run_x")!,
      store.get("run_x")!.playbook.steps[0]!,
    )).provider;

  it("is on by default at 100", async () => {
    const { store } = await setup("x");
    expect(store.get("run_x")!.playbook).toMatchObject({ usageCheck: true, usageThreshold: 100 });
  });

  it("skips a target whose provider is at 100% and logs it", async () => {
    const { store, runtime } = await setup("x", "", usage({ providerId: "claude", windows: [win("weekly", 100, inHours(30))] }));
    expect(await pick(runtime, store)).toBe("codex/gpt-5-mini");
    const line = store.get("run_x")!.history.find((entry) => entry.type === "provider_usage_skip")!;
    expect(line.detail).toMatch(/claude\/claude-haiku-5-5 skipped: weekly at 100% of its limit, resets/);
    // a second pick does not log it again
    await pick(runtime, store);
    expect(store.get("run_x")!.history.filter((entry) => entry.type === "provider_usage_skip")).toHaveLength(1);
  });

  it("uses the target below the threshold, and skips at a lower configured threshold", async () => {
    const half = usage({ providerId: "claude", windows: [win("weekly", 92)] });
    const a = await setup("x", "", half);
    expect(await pick(a.runtime, a.store)).toBe("claude/claude-haiku-5-5");
    const b = await setup("x", "providers: { usage: { threshold: 90 } }\n", half);
    expect(b.store.get("run_x")!.playbook.usageThreshold).toBe(90);
    expect(await pick(b.runtime, b.store)).toBe("codex/gpt-5-mini");
  });

  it("ignores a window of another model", async () => {
    const { store, runtime } = await setup("x", "", usage({ providerId: "claude", windows: [win("weekly", 40), win("weekly_model_fable", 100)] }));
    expect(await pick(runtime, store)).toBe("claude/claude-haiku-5-5");
  });

  it("treats a provider whose usage is missing, unavailable, empty or unreadable as usable", async () => {
    for (const listUsage of [
      usage({ providerId: "codex", windows: [] }),
      usage({ providerId: "claude", windows: [win("weekly", 100)], status: "error" }),
      usage({ providerId: "claude", windows: [] }),
      async () => {
        throw new Error("daemon down");
      },
    ]) {
      const { store, runtime } = await setup("x", "", listUsage);
      expect(await pick(runtime, store)).toBe("claude/claude-haiku-5-5");
    }
    const none = await setup("x");
    expect(await pick(none.runtime, none.store)).toBe("claude/claude-haiku-5-5");
  });

  it("ignores a full window whose reset time has passed", async () => {
    const { store, runtime } = await setup("x", "", usage({ providerId: "claude", windows: [win("weekly", 100, inHours(-1))] }));
    expect(await pick(runtime, store)).toBe("claude/claude-haiku-5-5");
  });

  it("reads usage once for concurrent picks and reuses it for a while", async () => {
    const listUsage = vi.fn(usage({ providerId: "claude", windows: [win("weekly", 100)] }));
    const { store, runtime } = await setup("x", "", listUsage);
    await Promise.all([pick(runtime, store), pick(runtime, store), pick(runtime, store)]);
    expect(listUsage).toHaveBeenCalledTimes(1);
    await pick(runtime, store);
    expect(listUsage).toHaveBeenCalledTimes(1);
  });

  it("does not read usage with check: false", async () => {
    const listUsage = vi.fn(usage({ providerId: "claude", windows: [win("weekly", 100)] }));
    const { store, runtime } = await setup("x", "providers: { usage: { check: false } }\n", listUsage);
    expect(await pick(runtime, store)).toBe("claude/claude-haiku-5-5");
    expect(listUsage).not.toHaveBeenCalled();
  });

  it("still fails over on a quota error when usage did not show the provider full", async () => {
    const { store, created, runtime } = await setup("rate limit exceeded", "", usage({ providerId: "claude", windows: [win("weekly", 50)] }));
    await runtime.onTurnEnded("step-1", "failed");
    expect(created[0]!.config.provider).toBe("codex/gpt-5-mini");
    expect(store.get("run_x")!.exhausted.map((entry) => entry.target)).toEqual(["claude/claude-haiku-5-5"]);
  });

  it("waits until the earliest provider reset when every target is full", async () => {
    const reset = inHours(5);
    const { store, runtime, created } = await setup(
      "rate limit exceeded",
      "providers: { on_exhausted: wait }\n",
      usage({ providerId: "claude", windows: [win("weekly", 100, inHours(30))] }, { providerId: "codex", windows: [win("weekly", 100, reset)] }),
    );
    await runtime.onTurnEnded("step-1", "failed");
    expect(created).toHaveLength(0);
    const waiting = store.get("run_x")!.steps.release!.attempts[0]!.waiting!;
    expect(waiting).not.toBeNull();
    expect(Date.parse(waiting.until)).toBe(Date.parse(reset));
  });

  it("without wait, every target full leaves the failure to the manager", async () => {
    const { store, runtime, created } = await setup(
      "rate limit exceeded",
      "",
      usage({ providerId: "claude", windows: [win("weekly", 100)] }, { providerId: "codex", windows: [win("weekly", 100)] }),
    );
    await runtime.onTurnEnded("step-1", "failed");
    expect(created).toHaveLength(0);
    expect(store.get("run_x")!.steps.release!.status).not.toBe("running");
  });

  it("a new manager skips a full provider", async () => {
    const { runtime, store } = await setup("x", "manager: { tier: cheap }\n", usage({ providerId: "claude", windows: [win("weekly", 100)] }));
    const skips = await (runtime as unknown as { managerSkips: (playbook: unknown) => Promise<string[]> }).managerSkips(store.get("run_x")!.playbook);
    expect(skips).toContain("claude/claude-haiku-5-5");
  });
});
