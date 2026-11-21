import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { RateHeldError, Runtime } from "./runtime";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
const saved = process.env.PASEO_HOME;
afterEach(async () => {
  if (saved === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = saved;
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
beforeEach(() => void (process.env.PASEO_HOME = ""));

const PLAYBOOK = `
title: Work
steps:
  - id: a
    role: { name: implementer, agent: { provider: claude, model: m } }
    manage: { auto_start: false }
  - id: b
    needs: [a]
    role: { name: implementer, agent: { provider: claude, model: m } }
    manage: { auto_start: false }
`;

const HOUR = 3_600_000;
/** A weekly window with `used` points, 50 of 168 hours gone: the pace ceiling is 28.87 points at 97 usable. */
const weekly = (used: number) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: new Date(Date.now() + 118 * HOUR).toISOString() });

async function setup(rateLimits: string, usage: { current: unknown } = { current: { providers: [] } }, options: { history?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "rl-runtime-"));
  temps.push(dir);
  process.env.PASEO_HOME = dir;
  await mkdir(path.join(dir, "plugin-data/lerenn/paseo-playbooks"), { recursive: true });
  await writeFile(path.join(dir, "plugin-data/lerenn/paseo-playbooks/config.yaml"), rateLimits);
  // A playbook's cost comes only from measured history: seed 5 points per step on the weekly window unless the test wants none.
  if (options.history !== false) await writeFile(path.join(dir, "plugin-data/lerenn/paseo-playbooks/rate-history.json"), JSON.stringify({ "work|claude\u0000weekly": { points: 5, steps: 1 } }));
  const root = path.join(dir, "repo/.paseo/playbooks");
  await mkdir(path.join(root, "roles/implementer"), { recursive: true });
  await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
  await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(path.join(dir, "repo"))).entries.find((candidate) => candidate.id === "work")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const now = new Date().toISOString();
  for (const id of ["r0", "r1"]) await store.create(newRun({ id, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: id === "r0" ? now : new Date(Date.parse(now) + 1000).toISOString() }));
  const sent: string[] = [];
  const created: string[] = [];
  const paseo = {
    providers: { listUsage: async () => usage.current },
    agents: { ref: () => ({ refresh: async () => ({ agent: { id: "m", status: "running", provider: "claude", model: null, archivedAt: null } }), send: async (text: string) => void sent.push(text) }) },
    workspaces: { ref: () => ({ agents: { create: async () => ({ id: `step-${created.push("x")}`, send: async () => undefined }) } }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  const internals = runtime as unknown as {
    pacer: { refresh(): Promise<void> };
    rateCheck(run: unknown, key?: string, quota?: boolean, step?: string): Promise<unknown>;
    releaseHolds(): Promise<void>;
    observeUsage(changes: unknown[]): void;
    costs: { stepCost(playbook: string, provider: string, window: string): number | null };
  };
  return { store, runtime, sent, created, usage, internals, read: () => internals.pacer.refresh() };
}

describe("rate limiting in the runtime", () => {
  it("does nothing when no limit is set", async () => {
    const { runtime, store, created } = await setup("");
    await runtime.startStep("m", "r1", "a", "go");
    expect(created).toHaveLength(1);
    expect(store.get("r1")!.rateHold).toBeNull();
  });

  it("holds the second run at the playbook limit, tells its manager, and resumes it by itself when the first ends", async () => {
    const { runtime, store, sent } = await setup("rate_limits: { playbooks: 1 }");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    const hold = store.get("r1")!.rateHold!;
    expect(hold.kind).toBe("playbooks");
    expect(hold.reason).toContain("playbook limit");
    expect(store.get("r1")!.steps.a!.status).toBe("ready");
    expect(store.get("r1")!.inbox.join("\n") + sent.join("\n")).toContain("Rate limit: this run is on hold");
    // The first run ends: the plugin lifts the hold without any agent action.
    await store.mutate("r0", (run) => void (run.status = "completed"));
    await (runtime as unknown as { releaseHolds(): Promise<void> }).releaseHolds();
    expect(store.get("r1")!.rateHold).toBeNull();
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.steps.a!.status).toBe("running");
  });

  it("lifts a hold at once when a run ends, without waiting for the 15 s timer", async () => {
    const { runtime, store } = await setup("rate_limits: { playbooks: 1 }");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r1")!.rateHold!.kind).toBe("playbooks");
    // No releaseHolds() call and no timer advance: the end of r0 alone triggers the re-check (debounced).
    await store.mutate("r0", (run) => void (run.status = "completed"));
    for (let i = 0; i < 60 && store.get("r1")!.rateHold; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.get("r1")!.rateHold).toBeNull();
  });

  it("holds a step when the step limit is full", async () => {
    const { runtime, store } = await setup("rate_limits: { steps: 1 }");
    await runtime.startStep("m", "r0", "a", "go");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toThrow(/step limit reached/);
    expect(store.get("r1")!.rateHold!.kind).toBe("steps");
  });
});

describe("dynamic capacity from quota headroom", () => {
  const pacing = (mode: string, extra = "") => `rate_limits: { mode: ${mode}, ${extra} quota: { pacing: true, refresh_interval: 1h, max_age: 2h } }`;
  const claude = (used: number) => ({ providers: [{ providerId: "claude", status: "available", windows: [weekly(used)] }] });

  it("playbook mode admits a whole run when the headroom covers its estimated cost, holds the next, and reserves the first's cost", async () => {
    // Ceiling 28.87, used 10: 18.87 free. A run is 2 steps x 5 = 10 points: one run fits, not two.
    const { runtime, store, internals, read } = await setup(pacing("playbook"), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    expect(store.get("r0")!.rateHold).toBeNull();
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r1")!.rateHold).toMatchObject({ kind: "headroom", provider: "claude", window: "weekly", estimatedCost: 10, position: 1, priority: 0 });
    expect(store.get("r1")!.rateHold!.headroom).toBeCloseTo(8.87, 1);
    expect(store.get("r1")!.rateHold!.reason).toContain("insufficient quota headroom");
    expect(store.get("r1")!.steps.a!.status).toBe("ready");
    // Not evicted: the admitted run's next step is never held for lack of headroom, even with a higher-priority run waiting.
    await store.mutate("r1", (run) => void (run.priority = 9));
    await store.mutate("r0", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true, "b")).toBeNull();
  });

  it("holds an admitted run between steps only when its quota is exhausted", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing("playbook"), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await store.mutate("r0", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    usage.current = claude(98);
    await read();
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true, "b")).toMatchObject({ kind: "quota", provider: "claude" });
  });

  it("pauses an admitted run between steps when the pace no longer fits it, never a running step, and resumes it when capacity returns", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing("playbook"), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    // Usage jumps ahead of the pace: 28.87 - 25 = 3.87 free, the run still needs 10.
    usage.current = claude(25);
    await read();
    // The jump came from outside the plugin: none of it counts as this run's own use.
    const inner = runtime as unknown as { reservedQuota: Map<string, { spent: Record<string, number> }>; attemptUse: Map<string, unknown> };
    for (const entry of inner.reservedQuota.values()) entry.spent = {};
    inner.attemptUse.clear();
    // A step is running: it is not interrupted and the run is not paused yet.
    expect(await internals.rateCheck(store.get("r0")!, "", true)).toBeNull();
    await store.mutate("r0", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true, "b")).toMatchObject({ kind: "pace", position: 1, provider: "claude", window: "weekly" });
    expect(store.get("r0")!.rateHold).toMatchObject({ kind: "pace" });
    // The pace relaxes (usage back down): the run resumes by itself.
    usage.current = claude(5);
    await read();
    await internals.releaseHolds();
    expect(store.get("r0")!.rateHold).toBeNull();
  });

  it("a higher priority goes first (a run's own priority overrides the playbook's); a lower one is held", async () => {
    const { runtime, store, read } = await setup(pacing("playbook"), { current: claude(10) });
    await store.mutate("r1", (run) => void (run.priority = 5));
    await read();
    await expect(runtime.startStep("m", "r0", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r0")!.rateHold!.priority).toBe(0);
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.steps.a!.status).toBe("running");
  });

  it("releases held runs by itself when headroom returns", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing("playbook"), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    // The first run ends and its reserved cost goes away with the next reading (usage down: a new window, say).
    await store.mutate("r0", (run) => void (run.status = "completed"));
    usage.current = claude(1);
    await read();
    await internals.releaseHolds();
    expect(store.get("r1")!.rateHold).toBeNull();
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.steps.a!.status).toBe("running");
  });

  it("step mode holds runs between steps and releases them one step at a time, by priority", async () => {
    // 18.87 free, a step is 5: three fit now; reserve them and the fourth waits. Use a smaller headroom: used 20 = 8.87 free, one step.
    const { runtime, store, internals, usage, read } = await setup(pacing("step"), { current: claude(20) });
    await read();
    await store.mutate("r1", (run) => void (run.priority = 1));
    await runtime.startStep("m", "r1", "a", "go");
    await expect(runtime.startStep("m", "r0", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r0")!.rateHold).toMatchObject({ kind: "headroom", estimatedCost: 5, position: 1 });
    // r1 finishes its step; its next step is also queued like any other, behind nothing but its own priority.
    await store.mutate("r1", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    usage.current = claude(21);
    await read();
    await internals.releaseHolds();
    // Priority 1 first: r1's step b is released, r0 still waits.
    expect(store.get("r1")!.rateHold).toBeNull();
    expect(store.get("r0")!.rateHold).not.toBeNull();
  });

  it("does not pace a provider that reports no usage, and says so in the run", async () => {
    const { runtime, store, read } = await setup(pacing("playbook"), { current: { providers: [{ providerId: "claude", status: "available", windows: [] }] } });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.rateHold).toBeNull();
    expect(store.get("r1")!.rateNote).toContain("claude");
    expect(store.get("r1")!.rateNote).toContain("not paced");
  });

  it("a playbook with no history yet is not paced by cost, and learns from its first measure", async () => {
    // Same config but a playbook without history: both runs start although the headroom (8.87) could not hold two 10-point runs.
    const { runtime, store, internals, read } = await setup(pacing("playbook"), { current: claude(20) }, { history: false });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.rateHold).toBeNull();
    const now = Date.now();
    for (const id of ["r0", "r1"]) await store.mutate(id, (run) => void (((run.steps.a!.attempts[0]!.startedAt = new Date(now - 30_000).toISOString()), (run.steps.a!.attempts[0]!.endedAt = new Date(now).toISOString())), (run.steps.a!.status = "completed")));
    const window = (used: number) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: weekly(0).resetsAt });
    internals.observeUsage([{ provider: "claude", before: { entry: { providerId: "claude", windows: [window(20)] }, at: now - 60_000 }, after: { entry: { providerId: "claude", windows: [window(24)] }, at: now } }]);
    // Two steps shared 4 points: 2 each. From now on the estimate comes from history.
    expect(internals.costs.stepCost("work", "claude", "weekly")).toBeCloseTo(2, 1);
  });

  it("learns what a playbook's steps cost from the usage readings", async () => {
    const { runtime, store, internals, read } = await setup(pacing("playbook"), { current: claude(10) }, { history: false });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    const now = Date.now();
    await store.mutate("r0", (run) => void (((run.steps.a!.attempts[0]!.startedAt = new Date(now - 30_000).toISOString()), (run.steps.a!.attempts[0]!.endedAt = new Date(now).toISOString())), (run.steps.a!.status = "completed")));
    const window = (used: number) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: weekly(0).resetsAt });
    internals.observeUsage([{ provider: "claude", before: { entry: { providerId: "claude", windows: [window(10)] }, at: now - 60_000 }, after: { entry: { providerId: "claude", windows: [window(13)] }, at: now } }]);
    expect(internals.costs.stepCost("work", "claude", "weekly")).toBeCloseTo(3, 1);
  });
});
