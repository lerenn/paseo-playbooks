import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "./engine";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { MANAGER_TOOL_NAMES, RateHeldError, Runtime, STEP_TOOL_NAMES } from "./runtime";
import { runTools } from "./tools";
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

const WITH_RETRO = `${PLAYBOOK}after:
  - id: retro
    role: { name: implementer, agent: { provider: claude, model: m } }
`;

const HOUR = 3_600_000;
/** A weekly window with `used` points, 50 of 168 hours gone: what is allowed so far is 28.87 points at 97 usable. */
const weekly = (used: number) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: new Date(Date.now() + 118 * HOUR).toISOString() });

async function setup(rateLimits: string, usage: { current: unknown } = { current: { providers: [] } }, options: { history?: boolean; seed?: unknown; yaml?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "rl-runtime-"));
  temps.push(dir);
  process.env.PASEO_HOME = dir;
  await mkdir(path.join(dir, "plugin-data/lerenn/paseo-playbooks"), { recursive: true });
  await writeFile(path.join(dir, "plugin-data/lerenn/paseo-playbooks/config.yaml"), rateLimits);
  // A playbook's cost comes only from measured history: seed 5 points per step on the weekly window unless the test wants none.
  if (options.history !== false) await writeFile(path.join(dir, "plugin-data/lerenn/paseo-playbooks/rate-history.json"), JSON.stringify(options.seed ?? { "work|claude\u0000weekly": { points: 5, steps: 1 } }));
  const root = path.join(dir, "repo/.paseo/playbooks");
  await mkdir(path.join(root, "roles/implementer"), { recursive: true });
  await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
  await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), options.yaml ?? PLAYBOOK);
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
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: dir }), agents: { create: async () => ({ id: `step-${created.push("x")}`, send: async () => undefined }) } }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  const internals = runtime as unknown as {
    pacer: { refresh(): Promise<void> };
    rateCheck(run: unknown, key?: string, quota?: boolean): Promise<unknown>;
    releaseHolds(): Promise<void>;
    observeUsage(changes: unknown[]): void;
    costs: { stepCost(playbook: string, provider: string, window: string): number | null; rows(): Array<{ pointsPerHour: number | null; agentMs: number | null }>; stepDuration(playbook: string, step: string): number | null };
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
    expect(store.get("r1")!.inbox.join("\n") + sent.join("\n")).toContain("Rate limit hold (");
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

describe("the hold notice to the manager (ADR 2026-11-23-warden-held-check)", () => {
  const verdict = (extra: object = {}) => ({ kind: "pace" as const, reason: "claude weekly at 41% above its allowance so far 36%", provider: "claude", window: "weekly", retryAt: "2026-11-24T10:00:00Z", estimatedCost: null, headroom: null, position: null, priority: null, ...extra });
  const spy = async () => {
    const s = await setup("");
    const enqueue = vi.spyOn(s.runtime as never, "enqueue" as never).mockResolvedValue(undefined as never);
    vi.spyOn(s.runtime as never, "deliver" as never).mockResolvedValue(undefined as never);
    const apply = (v: unknown) => (s.runtime as unknown as { applyHold(id: string, v: unknown): Promise<void> }).applyHold("r1", v);
    const texts = () => enqueue.mock.calls.map((call) => (call[1] as string[]).join(" "));
    return { ...s, apply, texts };
  };

  it("is short, and tells the manager not to start steps", async () => {
    const s = await spy();
    await s.apply(verdict());
    expect(s.texts()).toEqual(["Rate limit hold (claude weekly at 41% above its allowance so far 36%). The plugin resumes the run by itself: do not start, retry or restart steps, or cancel the run."]);
  });

  it("is sent once: a new retry time, position, headroom or reason does not repeat it", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.apply(verdict({ retryAt: "2026-11-24T11:00:00Z" }));
    await s.apply(verdict({ reason: "claude weekly at 40% above its allowance so far 36%", position: 2, headroom: 3, estimatedCost: 9 }));
    expect(s.texts()).toHaveLength(1);
    expect(s.store.get("r1")!.rateHold!.position).toBe(2);
  });

  it("an episode with flapping kinds, providers and windows sends exactly one notice", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.apply(verdict({ kind: "headroom", reason: "insufficient quota headroom on claude weekly" }));
    await s.apply(verdict({ kind: "quota", reason: "waiting for quota data on claude", window: null }));
    await s.apply(verdict({ kind: "headroom", window: "five_hour", provider: "codex" }));
    expect(s.texts()).toHaveLength(1);
  });

  const waiting = (extra: object = {}) => ({ kind: "quota" as const, reason: "waiting for quota data on claude", provider: "claude", window: null, retryAt: "2026-11-24T10:00:00Z", ...extra });

  it("never tells the manager of a hold that only waits for the provider's usage reading, nor of its end", async () => {
    const s = await spy();
    await s.apply(waiting());
    await s.apply(waiting({ retryAt: "2026-11-24T10:05:00Z" }));
    await s.apply(null);
    expect(s.texts()).toEqual([]);
  });

  it("a real headroom hold after an unavailable one in the same run still gets its one notice, and the flips add none", async () => {
    const s = await spy();
    await s.apply(waiting());
    await s.apply(verdict({ kind: "headroom", reason: "insufficient quota headroom on claude weekly" }));
    await s.apply(waiting());
    await s.apply(verdict({ kind: "headroom", reason: "insufficient quota headroom on claude weekly" }));
    expect(s.texts()).toHaveLength(1);
    expect(s.texts()[0]).toContain("insufficient quota headroom");
  });

  it("a flip between headroom and unavailable keeps one hold: one run_held, no release, the start kept", async () => {
    const s = await spy();
    await s.apply(verdict({ kind: "headroom" }));
    const since = s.store.get("r1")!.rateHold!.since;
    await s.apply(waiting());
    await s.apply(verdict({ kind: "headroom" }));
    const run = s.store.get("r1")!;
    expect(run.history.filter((entry) => entry.type === "run_held")).toHaveLength(1);
    expect(run.history.filter((entry) => entry.type === "run_released")).toHaveLength(0);
    expect(run.rateHold!.since).toBe(since);
  });

  it("a hold lifted and re-taken before any step starts sends nothing more", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.store.mutate("r1", (run) => void (run.steps.a!.status = "running")); // nothing waits for the manager at the release
    await s.apply(null);
    await s.apply(verdict());
    await s.apply(null);
    await s.apply(verdict({ kind: "headroom" }));
    expect(s.texts()).toHaveLength(1);
  });

  it("a step start ends the episode and re-arms the notice", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.apply(null);
    await s.store.mutate("r1", (run) => void engine.noteEvent(run, "step_started", "a", "attempt 1, agent x", "2026-11-24T00:00:00Z"));
    await s.apply(verdict({ kind: "headroom" }));
    expect(s.texts().filter((text) => text.startsWith("Rate limit hold"))).toHaveLength(2);
  });

  it("the episode is read from the run history, so it survives a restart", async () => {
    const s = await spy();
    await s.apply(verdict());
    expect(engine.holdEpisodeState(s.store.get("r1")!)).toBe("told");
    await s.apply(null);
    expect(engine.holdEpisodeState(s.store.get("r1")!)).toBe("released");
  });

  it("a different run has its own episode", async () => {
    const s = await spy();
    await s.apply(verdict());
    await (s.runtime as unknown as { applyHold(id: string, v: unknown): Promise<void> }).applyHold("r0", verdict());
    expect(s.texts()).toHaveLength(2);
  });

  it("a release is told only when the manager knew of the hold and a step now waits for it, and only once per episode", async () => {
    const quiet = await spy();
    await quiet.apply(null);
    expect(quiet.texts()).toEqual([]);
    const s = await spy();
    await s.apply(verdict());
    await s.apply(null);
    expect(s.texts()).toHaveLength(2);
    expect(s.texts()[1]).toBe("Rate limit lifted. Ready for you: a.");
    await s.apply(verdict()); // the release does not re-arm the hold notice
    await s.apply(null); // nor is the release told twice
    expect(s.texts()).toHaveLength(2);
  });

  it("a script start that skips the quota does not lift a quota hold", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.internals.rateCheck(s.store.get("r1"), "", false);
    expect(s.store.get("r1")!.rateHold).not.toBeNull();
    expect(s.texts()).toHaveLength(1);
  });
});

describe("dynamic capacity from quota headroom", () => {
  const pacing = (extra = "") => `rate_limits: { ${extra} quota: { pacing: true, refresh_interval: 1h, max_age: 2h } }`;
  const claude = (used: number) => ({ providers: [{ providerId: "claude", status: "available", windows: [weekly(used)] }] });

  it("admits a whole run when the headroom covers its estimated cost, holds the next, and reserves the first's cost", async () => {
    // Ceiling 28.87, used 10: 18.87 free. A run is 2 steps x 5 = 10 points: one run fits, not two.
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(10) });
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
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
  });

  it("a burn rate reset makes the playbook unpaced at once: reservations emptied, a held run released, the event emitted, the history erased", async () => {
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(10) });
    await read();
    const emit = vi.spyOn((runtime as unknown as { bus: { emit: (...args: unknown[]) => Promise<unknown> } }).bus, "emit");
    await runtime.startStep("m", "r0", "a", "go");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    const inner = runtime as unknown as { reservedQuota: Map<string, { est: Record<string, number>; spent: Record<string, number> }> };
    expect(Object.keys(inner.reservedQuota.get("run:r0")!.est).length).toBeGreaterThan(0);
    const result = await runtime.resetBurnRate("work", null, "test");
    expect(result.erased).toEqual({ entries: 1, steps: 1, ms: 0 });
    expect(internals.costs.stepCost("work", "claude", "weekly")).toBeNull();
    // No history, no need: the admitted run reserves nothing and the held run is no longer paced.
    expect(inner.reservedQuota.get("run:r0")!.est).toEqual({});
    expect(store.get("r1")!.rateHold).toBeNull();
    expect(emit).toHaveBeenCalledWith("quota.burn_rate_reset", { playbook: "work", step: null, erased: { entries: 1, steps: 1, ms: 0 }, by: "test" }, { runId: null, source: "runs" });
    // Idempotent.
    expect((await runtime.resetBurnRate("work", null, "test")).erased).toEqual({ entries: 0, steps: 0, ms: 0 });
    await expect(runtime.resetBurnRate("  ", null, "test")).rejects.toThrow("playbook is required");
  });

  it("reset_burn_rate: exactly one of playbook or all, per-playbook counts and one event each, live effects, manager-only", async () => {
    const seed = { "work|claude\u0000weekly": { points: 5, steps: 1, ms: HOUR, timedPoints: 5 }, "other|claude\u0000weekly": { points: 3, steps: 1, ms: HOUR / 2, timedPoints: 3 }, "@stepTimes": { "other|a": { ms: 30 * 60_000, n: 1 } } };
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(10) }, { seed });
    await read();
    const emit = vi.spyOn((runtime as unknown as { bus: { emit: (...args: unknown[]) => Promise<unknown> } }).bus, "emit");
    const tool = runTools(runtime).find((candidate) => candidate.name === "reset_burn_rate")!;
    const run = (input: unknown) => (tool as unknown as { execute(input: unknown, ctx: unknown): Promise<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown }> }).execute(input, { agent: { id: "mgr" } });
    const schema = (tool as unknown as { input: { safeParse(value: unknown): { success: boolean } } }).input;
    expect(schema.safeParse({ playbook: "work", step: "a" }).success).toBe(true);
    expect(schema.safeParse({ all: "yes" }).success).toBe(false);
    // Validation: neither, or both.
    await expect(runtime.resetBurnRates({}, "agent mgr")).rejects.toThrow("pass a playbook");
    await expect(runtime.resetBurnRates({ playbook: "work", all: true }, "agent mgr")).rejects.toThrow("not both");
    expect((await run({})).isError).toBe(true);
    expect((await run({ all: true, step: "a" })).isError).toBe(true);
    expect(internals.costs.stepCost("work", "claude", "weekly")).not.toBeNull();
    // Live effects: held run released, reservations emptied.
    await runtime.startStep("m", "r0", "a", "go");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    const result = await run({ all: true });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).toContain("other");
    expect(result.structuredContent).toMatchObject({ all: true, erased: { entries: 2, steps: 2, ms: HOUR * 1.5 }, playbooks: [{ playbook: "other", erased: { entries: 1, steps: 1, ms: HOUR / 2 } }, { playbook: "work", erased: { entries: 1, steps: 1, ms: HOUR } }] });
    expect(internals.costs.stepCost("work", "claude", "weekly")).toBeNull();
    expect(internals.costs.stepDuration("other", "a")).toBeNull();
    expect(store.get("r1")!.rateHold).toBeNull();
    const resets = emit.mock.calls.filter((call) => call[0] === "quota.burn_rate_reset");
    expect(resets.map((call) => (call[1] as { playbook: string }).playbook)).toEqual(["other", "work"]);
    expect(resets.every((call) => (call[1] as { by: string }).by === "agent mgr")).toBe(true);
    // Idempotent: nothing left, nothing erased.
    expect((await runtime.resetBurnRates({ all: true }, "agent mgr")).playbooks).toEqual([]);
    expect((await run({ playbook: "work" })).structuredContent).toMatchObject({ all: false, erased: { entries: 0, steps: 0, ms: 0 } });
    expect(MANAGER_TOOL_NAMES).toContain("reset_burn_rate");
    expect(STEP_TOOL_NAMES).not.toContain("reset_burn_rate");
  });

  it("a step reset clears that step's duration only and the run is priced by the unit cost for it", async () => {
    const seed = { "work|claude\u0000weekly": { points: 6, steps: 1, ms: HOUR, timedPoints: 6 }, "@stepTimes": { "work|a": { ms: 30 * 60_000, n: 1 }, "work|b": { ms: 10 * 60_000, n: 1 } } };
    const { runtime, internals, read } = await setup(pacing(), { current: claude(1) }, { seed });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    const inner = runtime as unknown as { reservedQuota: Map<string, { est: Record<string, number>; spent: Record<string, number> }> };
    const need = () => (inner.reservedQuota.get("run:r0")!.est["claude\u0000weekly"] ?? 0) - (inner.reservedQuota.get("run:r0")!.spent["claude\u0000weekly"] ?? 0);
    expect(need()).toBeCloseTo(4, 0);
    expect((await runtime.resetBurnRate("work", "a", "test")).erased).toMatchObject({ steps: 1 });
    expect(internals.costs.stepDuration("work", "a")).toBeNull();
    // Step a is priced by the unit cost (6) again, step b by duration (1).
    expect(need()).toBeCloseTo(7, 0);
  });

  it("holds an admitted run between steps only when its quota is exhausted", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await store.mutate("r0", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    usage.current = claude(98);
    await read();
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toMatchObject({ kind: "quota", provider: "claude" });
  });

  it("pauses an admitted run between steps when the pace no longer fits it, never a running step, and resumes it when capacity returns", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(10) });
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
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toMatchObject({ kind: "pace", position: 1, provider: "claude", window: "weekly" });
    expect(store.get("r0")!.rateHold).toMatchObject({ kind: "pace" });
    // The pace relaxes (usage back down): the run resumes by itself.
    usage.current = claude(5);
    await read();
    await internals.releaseHolds();
    expect(store.get("r0")!.rateHold).toBeNull();
  });

  describe("restart_run under a burn rate limit", () => {
    const fail = (store: RunStore) =>
      store.mutate("r0", (run) => {
        run.status = "failed";
        run.failure = "boom";
        run.steps.a!.status = "failed";
        run.after.retro = { status: "running", startedAt: new Date().toISOString(), endedAt: null, detail: null };
        run.steps.retro!.status = "ready";
        run.rateHold = { kind: "pace", provider: "claude", window: "weekly", reason: "held for the retro", retryAt: null, since: new Date().toISOString(), estimatedCost: null, headroom: null, position: null, priority: null };
      });

    it("moves a failed run with a held retro to held at once: the step is reset, the retro canceled, the reservation released", async () => {
      const { runtime, store, usage, read } = await setup(pacing(), { current: claude(10) }, { yaml: WITH_RETRO });
      await read();
      usage.current = claude(25);
      await read();
      await fail(store);
      await store.mutate("r1", (run) => void (run.status = "canceled"));
      (runtime as unknown as { reservedQuota: Map<string, unknown> }).reservedQuota.set("run:r0", { runId: "r0", est: {}, spent: {}, at: Date.now(), endedAt: null });
      await runtime.restartRun("r0", "a", null, "laptop");
      const run = store.get("r0")!;
      expect(run.status).toBe("running");
      expect(run.status).not.toBe("failed");
      expect(run.rateHold).toMatchObject({ kind: expect.stringMatching(/pace|headroom|quota/) });
      expect(run.rateHold!.reason).not.toBe("held for the retro");
      expect(run.steps.a!.status).toBe("ready");
      expect(run.after.retro!.status).toBe("pending");
      expect(run.history.some((event) => event.type === "after_canceled" && event.detail.includes("restart"))).toBe(true);
      expect((runtime as unknown as { reservedQuota: Map<string, unknown> }).reservedQuota.has("run:r0")).toBe(false);
    });

    it("restarts an exempt run at once, with no hold", async () => {
      const { runtime, store, usage, read } = await setup(pacing(), { current: claude(10) }, { yaml: WITH_RETRO });
      await read();
      usage.current = claude(25);
      await read();
      await fail(store);
      await store.mutate("r1", (run) => void (run.status = "canceled"));
      await store.mutate("r0", (run) => void (run.quotaExempt = true));
      await runtime.restartRun("r0", "a", null, "laptop");
      const run = store.get("r0")!;
      expect(run.status).toBe("running");
      expect(run.rateHold).toBeNull();
      expect(run.steps.a!.status).toBe("ready");
      expect(run.after.retro!.status).toBe("pending");
    });
  });

  it("a higher priority goes first (a run's own priority overrides the playbook's); a lower one is held", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await store.mutate("r1", (run) => void (run.priority = 5));
    await read();
    await expect(runtime.startStep("m", "r0", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r0")!.rateHold!.priority).toBe(0);
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.steps.a!.status).toBe("running");
  });

  it("a manual override reorders the admission queue and the pace plan at once, and shows in the hold text", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(0) });
    await read();
    // Both admitted (2 x 10 points under the 28.87 ceiling).
    await runtime.startStep("m", "r0", "a", "go");
    await runtime.startStep("m", "r1", "a", "go");
    // Usage jumps ahead of the pace (8.87 free): one of them fits (5 left each once step a is done). Outside use, not the runs'.
    usage.current = claude(20);
    await read();
    const inner = runtime as unknown as { reservedQuota: Map<string, { spent: Record<string, number> }>; attemptUse: Map<string, unknown> };
    for (const entry of inner.reservedQuota.values()) entry.spent = {};
    inner.attemptUse.clear();
    for (const id of ["r0", "r1"]) await store.mutate(id, (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    // Same priority: the oldest (r0) keeps going, r1 is paused.
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
    expect(await internals.rateCheck(store.get("r1")!, "r1/b", true)).toMatchObject({ kind: "pace", position: 1, priority: 0 });
    // Raise r1 by hand: the order flips, the hold text carries the override, and r0 is the one paused now.
    await runtime.setRunPriority("r1", 5, undefined, "test");
    expect(await internals.rateCheck(store.get("r1")!, "r1/b", true)).toBeNull();
    const verdict = (await internals.rateCheck(store.get("r0")!, "r0/b", true)) as { priority: number; reason: string };
    expect(verdict).toMatchObject({ kind: "pace", priority: 0 });
    // Cleared: back to the playbook's priority and the age order.
    await runtime.setRunPriority("r1", null, undefined, "test");
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
    expect(store.get("r0")!.priorityOverride).toBeNull();
  });

  describe("admitted before any cost history existed", () => {
    type Inner = { reservedQuota: Map<string, { est: Record<string, number>; spent: Record<string, number> }>; attemptUse: Map<string, unknown>; costs: { add(p: string, provider: string, points: Record<string, number>): void }; refreshAdmittedNeeds(): void };
    const key = "claude\u0000weekly";
    const done = (store: RunStore, id: string) => store.mutate(id, (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));

    it("stays unpaced while the playbook still has no history", async () => {
      const { runtime, store, internals, read } = await setup(pacing(), { current: claude(40) }, { history: false });
      await read();
      await runtime.startStep("m", "r0", "a", "go");
      await done(store, "r0");
      expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
      expect((runtime as unknown as Inner).reservedQuota.get("run:r0")?.est[key] ?? 0).toBe(0);
    });

    it("gets a need from the history as soon as it exists; the lowest priority and newest is paused at its next step", async () => {
      const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(10) }, { history: false });
      await read();
      await runtime.startStep("m", "r0", "a", "go");
      await runtime.startStep("m", "r1", "a", "go");
      const inner = runtime as unknown as Inner;
      expect(inner.reservedQuota.get("run:r1")!.est[key] ?? 0).toBe(0);
      // The history appears (5 points a step) while both are admitted, and the usage is over what fits both.
      inner.costs.add("work", "claude", { weekly: 5 });
      usage.current = claude(20);
      await read();
      inner.attemptUse.clear();
      for (const entry of inner.reservedQuota.values()) entry.spent = {};
      await done(store, "r0");
      await done(store, "r1");
      // 8.87 free; each needs the 5 points of its step b: the oldest continues, the newest is paused.
      expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
      expect(await internals.rateCheck(store.get("r1")!, "r1/b", true)).toMatchObject({ kind: "pace", position: 1, provider: "claude", window: "weekly" });
      // The quota tab's reservation carries the new remaining figure.
      expect(inner.reservedQuota.get("run:r1")!.est[key]! - (inner.reservedQuota.get("run:r1")!.spent[key] ?? 0)).toBeCloseTo(5, 5);
    });

    it("deducts what the run's running steps already used", async () => {
      const { runtime, store, read } = await setup(pacing(), { current: claude(10) }, { history: false });
      await read();
      await runtime.startStep("m", "r0", "a", "go");
      const inner = runtime as unknown as Inner;
      inner.costs.add("work", "claude", { weekly: 5 });
      (inner.attemptUse as Map<string, unknown>).set("r0/a/1", { playbookId: "work", provider: "claude", points: { weekly: 3 } });
      inner.refreshAdmittedNeeds();
      const reserved = inner.reservedQuota.get("run:r0")!;
      // 2 remaining steps x 5, minus the 3 the running step used.
      expect(reserved.est[key]! - (reserved.spent[key] ?? 0)).toBeCloseTo(7, 5);
      expect(store.get("r0")!.steps.a!.status).toBe("running");
    });
  });

  it("releases held runs by itself when headroom returns", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(10) });
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

  it("does not pace a provider that reports no usage, and says so in the run", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: { providers: [{ providerId: "claude", status: "available", windows: [] }] } });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.rateHold).toBeNull();
    expect(store.get("r1")!.rateNote).toContain("claude");
    expect(store.get("r1")!.rateNote).toContain("not paced");
  });

  it("a playbook with no history yet is not paced by cost, and learns from its first measure", async () => {
    // Same config but a playbook without history: both runs start although the headroom (8.87) could not hold two 10-point runs.
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(20) }, { history: false });
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
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(10) }, { history: false });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    const now = Date.now();
    await store.mutate("r0", (run) => void (((run.steps.a!.attempts[0]!.startedAt = new Date(now - 30_000).toISOString()), (run.steps.a!.attempts[0]!.endedAt = new Date(now).toISOString())), (run.steps.a!.status = "completed")));
    const window = (used: number) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: weekly(0).resetsAt });
    internals.observeUsage([{ provider: "claude", before: { entry: { providerId: "claude", windows: [window(10)] }, at: now - 60_000 }, after: { entry: { providerId: "claude", windows: [window(13)] }, at: now } }]);
    expect(internals.costs.stepCost("work", "claude", "weekly")).toBeCloseTo(3, 1);
    // The agent time behind those 3 points: the attempt's 30 s inside the 60 s interval, i.e. 360 points per hour; its whole duration is the step's.
    expect(internals.costs.rows()[0]).toMatchObject({ agentMs: 30_000 });
    expect(internals.costs.rows()[0]!.pointsPerHour).toBeCloseTo(360, 0);
    expect(internals.costs.stepDuration("work", "a")).toBeCloseTo(30_000, -2);
  });

  it("an admitted run needs its remaining steps by expected duration x burn rate, not by the unit cost", async () => {
    // 6 points over an hour of agent time; step a takes 30 min, b 10 min: 3 + 1 points for the run, where the unit cost says 2 x 6 = 12.
    const seed = { "work|claude\u0000weekly": { points: 6, steps: 1, ms: HOUR, timedPoints: 6 }, "@stepTimes": { "work|a": { ms: 30 * 60_000, n: 1 }, "work|b": { ms: 10 * 60_000, n: 1 } } };
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(1) }, { seed });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    const inner = runtime as unknown as { reservedQuota: Map<string, { est: Record<string, number>; spent: Record<string, number> }>; refreshAdmittedNeeds(): void };
    const need = () => {
      inner.refreshAdmittedNeeds();
      const reserved = inner.reservedQuota.get("run:r0")!;
      return (reserved.est["claude\u0000weekly"] ?? 0) - (reserved.spent["claude\u0000weekly"] ?? 0);
    };
    // Step a just started (almost nothing elapsed): about 3 + 1.
    expect(need()).toBeGreaterThan(3.8);
    expect(need()).toBeLessThanOrEqual(4);
    // Step a has run 20 of its 30 minutes: 1 + 1.
    await store.mutate("r0", (run) => void (run.steps.a!.attempts[0]!.startedAt = new Date(Date.now() - 20 * 60_000).toISOString()));
    expect(need()).toBeCloseTo(2, 1);
    // Measured use of the running step is not deducted a second time (its elapsed time already is).
    (internals as unknown as { attemptUse: Map<string, unknown> }).attemptUse.set("r0/a/1", { playbookId: "work", provider: "claude", points: { weekly: 1.5 }, ms: { weekly: 1 } });
    expect(need()).toBeCloseTo(2, 1);
  });

  it("without a duration for the steps the old unit-cost need applies", async () => {
    const seed = { "work|claude\u0000weekly": { points: 6, steps: 1, ms: HOUR, timedPoints: 6 } };
    const { runtime, internals, read } = await setup(pacing(), { current: claude(1) }, { seed });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    const inner = runtime as unknown as { reservedQuota: Map<string, { est: Record<string, number>; spent: Record<string, number> }>; refreshAdmittedNeeds(): void };
    inner.refreshAdmittedNeeds();
    const reserved = inner.reservedQuota.get("run:r0")!;
    expect((reserved.est["claude\u0000weekly"] ?? 0) - (reserved.spent["claude\u0000weekly"] ?? 0)).toBeCloseTo(12, 5);
    void internals;
  });
});

describe("burn rate limits from the playbook defaults, per run", () => {
  const claude = (used: number) => ({ providers: [{ providerId: "claude", status: "available", windows: [weekly(used)] }] });
  type Layer = { quotaLimits: unknown };

  it("paces a run by its own defaults, with no user config: a project that sets usable_percent is paced, another is not", async () => {
    // Used 10: at 50 usable the ceiling is 14.9 (4.9 free < 10 for the run); a run with nothing set is not paced.
    const { store, internals, read } = await setup("", { current: claude(10) });
    await read();
    await store.mutate("r0", (run) => void ((run.playbook as unknown as Layer).quotaLimits = { quota: { pacing: true, usablePercent: 50 } }));
    expect(await internals.rateCheck(store.get("r0")!, "", false)).toBeNull();
    expect(await internals.rateCheck(store.get("r0")!, "", true)).toMatchObject({ kind: "headroom", provider: "claude", window: "weekly" });
    expect(await internals.rateCheck(store.get("r1")!, "", true)).toBeNull();
  });

  it("uses each run's own usable_percent over the same global reading, and the defaults over the user config", async () => {
    // The user config paces at 97 (18.87 free: a 10-point run fits); r0's defaults say 50 (4.9 free: it does not), r1's say nothing.
    const { store, internals, read } = await setup("quota_limits: { quota: { usable_percent: 97, refresh_interval: 1h, max_age: 2h } }", { current: claude(10) });
    await read();
    await store.mutate("r0", (run) => void ((run.playbook as unknown as Layer).quotaLimits = { quota: { usablePercent: 50 } }));
    await store.mutate("r1", (run) => void (run.priority = 9));
    expect(await internals.rateCheck(store.get("r1")!, "", true)).toBeNull();
    expect(await internals.rateCheck(store.get("r0")!, "", true)).toMatchObject({ kind: "headroom" });
  });

  it("a folder can turn the user config's pacing off for its own runs", async () => {
    const { store, internals, read } = await setup("quota_limits: { quota: { pacing: true, refresh_interval: 1h, max_age: 2h } }", { current: claude(25) });
    await read();
    await store.mutate("r0", (run) => void ((run.playbook as unknown as Layer).quotaLimits = { quota: { pacing: false } }));
    expect(await internals.rateCheck(store.get("r0")!, "", true)).toBeNull();
    expect(await internals.rateCheck(store.get("r1")!, "", true)).toMatchObject({ kind: "headroom" });
  });

  it("gates each run by the cap of its own config while counting every run", async () => {
    const { store, runtime } = await setup("");
    await runtime.startStep("m", "r0", "a", "go");
    // r0's config has no cap and passes; r1's config caps the runs at 1, and r0 counts: r1 waits.
    await store.mutate("r1", (run) => void ((run.playbook as unknown as Layer).quotaLimits = { playbooks: 1 }));
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r1")!.rateHold!.kind).toBe("playbooks");
  });
});

describe("runs exempt from burn rate limiting (ADR 2026-11-23-quota-exempt-runs)", () => {
  const pacing = (extra = "") => `rate_limits: { ${extra} quota: { pacing: true, refresh_interval: 1h, max_age: 2h } }`;
  const claude = (used: number) => ({ providers: [{ providerId: "claude", status: "available", windows: [weekly(used)] }] });
  const exempt = (store: RunStore, id: string) => store.mutate(id, (run) => void (run.quotaExempt = true));

  it("starts with no free headroom, with the window exhausted, and with the usage unavailable, and is never held", async () => {
    // 40 used is above the 28.87 ceiling: a normal run is held for quota.
    const { runtime, store, usage, read } = await setup(pacing(), { current: claude(40) });
    await read();
    await expect(runtime.startStep("m", "r0", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    await exempt(store, "r1");
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.steps.a!.status).toBe("running");
    expect(store.get("r1")!.rateHold).toBeNull();
    // The usage cannot be read at all.
    usage.current = { providers: [{ providerId: "claude", status: "unavailable", windows: [] }] };
    await read();
    await store.mutate("r1", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    await runtime.startStep("m", "r1", "b", "go");
    expect(store.get("r1")!.rateHold).toBeNull();
    expect(store.get("r1")!.inbox.join("\n")).not.toContain("Rate limit hold");
  });

  it("ignores the step and playbook caps", async () => {
    const { runtime, store } = await setup("rate_limits: { steps: 1, playbooks: 1 }");
    await runtime.startStep("m", "r0", "a", "go");
    await exempt(store, "r1");
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.rateHold).toBeNull();
    expect(store.get("r1")!.steps.a!.status).toBe("running");
  });

  it("is never paused between steps when the pace no longer fits it", async () => {
    const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(10) });
    await exempt(store, "r0");
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    usage.current = claude(25);
    await read();
    await store.mutate("r0", (run) => void ((run.steps.a!.status = "completed"), (run.steps.b!.status = "ready")));
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
    expect(store.get("r0")!.rateHold).toBeNull();
  });

  it("reserves its estimated cost, so a run that is not exempt sees less headroom and is held where it would have fit", async () => {
    // Ceiling 28.87, used 10: 18.87 free. The exempt run reserves 10 (2 steps x 5): 8.87 is left, and a normal run needs 10.
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await exempt(store, "r1");
    await read();
    await runtime.startStep("m", "r1", "a", "go");
    const reserved = (runtime as unknown as { reservedQuota: Map<string, { est: Record<string, number> }> }).reservedQuota.get("run:r1")!;
    expect(Object.values(reserved.est)).toEqual([10]);
    await expect(runtime.startStep("m", "r0", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    expect(store.get("r0")!.rateHold).toMatchObject({ kind: "headroom", estimatedCost: 10, position: 1 });
    expect(store.get("r0")!.rateHold!.headroom).toBeCloseTo(8.87, 1);
  });

  it("is no candidate of the queue, so it blocks no lower-priority waiter, and is no competitor of the pace plan", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await exempt(store, "r0");
    // r0 has the higher priority and has not started: were it in the queue, r1 would wait behind it.
    await store.mutate("r0", (run) => void (run.priority = 9));
    await read();
    const inner = runtime as unknown as { rateCandidates(run: unknown): Array<{ run: { id: string } }> };
    expect(inner.rateCandidates(store.get("r1")!).map((candidate) => candidate.run.id)).toEqual(["r1"]);
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.rateHold).toBeNull();
  });

  it("starts exempt, with nothing but the flag, and a child starts exempt when its parent is", async () => {
    const { runtime, store } = await setup("");
    await exempt(store, "r0");
    const inner = runtime as unknown as { parentExempt(parent: { runId: string; stepId: string; key: string } | undefined): boolean };
    expect(inner.parentExempt({ runId: "r0", stepId: "a", key: "k" })).toBe(true);
    expect(inner.parentExempt({ runId: "r1", stepId: "a", key: "k" })).toBe(false);
    expect(inner.parentExempt(undefined)).toBe(false);
  });
});

describe("provider usage events (ADR 2026-11-23-provider-usage-unavailable)", () => {
  it("emits one provider.usage_unavailable when the reading goes down and one provider.usage_restored when it is back, nothing in between", async () => {
    const s = await setup("");
    const emit = vi.spyOn(s.runtime.bus, "emit");
    const sync = () => (s.runtime as unknown as { syncProviderUsage(): Promise<void> }).syncProviderUsage();
    const states = vi.spyOn(s.internals.pacer as unknown as { usageStates(): Map<string, unknown> }, "usageStates");
    const since = Date.parse("2026-11-24T15:42:00Z");
    states.mockReturnValue(new Map([["claude", { available: true, since: null, lastReadAt: since, reason: null, failures: 0 }]]));
    await sync();
    states.mockReturnValue(new Map([["claude", { available: false, since, lastReadAt: since - 600_000, reason: "HTTP 429", failures: 3 }]]));
    await sync();
    await sync();
    states.mockReturnValue(new Map([["claude", { available: false, since, lastReadAt: since - 600_000, reason: "HTTP 500", failures: 4 }]]));
    await sync();
    states.mockReturnValue(new Map([["claude", { available: true, since: null, lastReadAt: since + 900_000, reason: null, failures: 0 }]]));
    await sync();
    await sync();
    expect(emit.mock.calls.map((call) => call[0])).toEqual(["provider.usage_unavailable", "provider.usage_restored"]);
    expect(emit.mock.calls[0]![1]).toMatchObject({ provider: "claude", since: "2026-11-24T15:42:00.000Z", reason: "HTTP 429", failures: 3 });
    expect(emit.mock.calls[1]![1]).toMatchObject({ provider: "claude", since: "2026-11-24T15:42:00.000Z", reason: "HTTP 429" });
  });
});

describe("a run waiting at a gate releases its reservation (ADR 2026-11-24-gate-waiting-releases-reservation)", () => {
  const pacing = (extra = "") => `quota_limits: { quota: { usable_percent: 97, refresh_interval: 1h, max_age: 2h${extra} } }`;
  const claude = (used: number) => ({ providers: [{ providerId: "claude", status: "available", windows: [weekly(used)] }] });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  type Inner = { reservedQuota: Map<string, { est: Record<string, number> }>; refreshAdmittedNeeds(): void };
  const reserved = (runtime: Runtime) => (runtime as unknown as Inner).reservedQuota;
  const refresh = (runtime: Runtime) => (runtime as unknown as Inner).refreshAdmittedNeeds();

  /** r0 finished step a, waits at a gate on b since `minutes` ago; deferred (Waiting) or not. */
  const wait = (store: RunStore, id: string, minutes: number, deferred = false) =>
    store.mutate(id, (run) => {
      run.createdAt = ago(minutes + 60);
      for (const attempt of run.steps.a!.attempts) Object.assign(attempt, { startedAt: ago(minutes + 5), endedAt: ago(minutes + 1) });
      run.steps.a!.status = "completed";
      run.steps.b!.status = "pending";
      run.status = "waiting_gate";
      run.gates.push({
        id: "g1", kind: "gate", jobId: null, stepId: "a", gotoTarget: null, outcome: null, status: "pending", message: "ok?", summary: "ok?", details: "", requestedAt: ago(minutes + 1), comment: null, decidedBy: null, decidedVia: null,
        decider: { by: "human" }, deciderAgentId: null, escalated: null, escalatedAt: null,
        deferral: deferred ? { reason: "later", condition: { kind: "manual", note: "" }, remindAt: null, deferredAt: ago(minutes), deferredBy: "human", returnedAt: null, returnedBy: null, returnNote: null } : null,
        decidedAt: null,
      } as never);
    });
  /** Like \`wait\`, with the gate left as it is (only the times move). */
  const wait2 = (store: RunStore, id: string, minutes: number) =>
    store.mutate(id, (run) => {
      for (const attempt of run.steps.a!.attempts) Object.assign(attempt, { startedAt: ago(minutes + 5), endedAt: ago(minutes + 1) });
      run.gates[0]!.requestedAt = ago(minutes + 1);
    });
  /** The human decides: the gate closes and step b is ready. */
  const decide = (store: RunStore, id: string) =>
    store.mutate(id, (run) => {
      Object.assign(run.gates[0]!, { status: "approved", decidedAt: new Date().toISOString(), decidedBy: "human", decidedVia: "panel" });
      run.steps.b!.status = "ready";
      run.status = "running";
    });

  it("frees its headroom after the grace, so another run starts; held again only when it returns and no longer fits", async () => {
    // Ceiling 28.87, used 10: 18.87 free. Each run is 10 points: only one fits at admission.
    const { runtime, store, internals, usage, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    await wait(store, "r0", 11);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
    // The headroom is free: r1 is admitted. Refreshing again never rebuilds the waiting run's reservation.
    await runtime.startStep("m", "r1", "a", "go");
    refresh(runtime);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
    expect(store.get("r1")!.rateHold).toBeNull();
    // The pace tightens (usage 18: 10.87 free) and the gate is decided; r1 outranks r0 and its running step still needs 10, so r0 (needing 5 more) is
    // held like any paused run: no failure, the decision stays.
    await store.mutate("r1", (run) => void (run.priority = 9));
    usage.current = claude(18);
    await read();
    const inner = runtime as unknown as { reservedQuota: Map<string, { spent: Record<string, number> }>; attemptUse: Map<string, unknown> };
    for (const entry of inner.reservedQuota.values()) entry.spent = {};
    inner.attemptUse.clear();
    await decide(store, "r0");
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toMatchObject({ kind: "pace" });
    expect(store.get("r0")!.rateHold).toMatchObject({ kind: "pace" });
    expect(store.get("r0")!.gates[0]).toMatchObject({ status: "approved" });
    expect(store.get("r0")!.steps.b!.status).toBe("ready");
    expect(reserved(runtime).has("run:r0")).toBe(true);
  });

  it("re-reserves when the gate is decided, and the run goes on when it still fits", async () => {
    const { runtime, store, internals, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await wait(store, "r0", 11);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
    await decide(store, "r0");
    expect(await internals.rateCheck(store.get("r0")!, "r0/b", true)).toBeNull();
    expect(reserved(runtime).has("run:r0")).toBe(true);
  });

  it("keeps the reservation inside the grace for an ordinary open gate", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await wait(store, "r0", 3);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(true);
    await wait2(store, "r0", 11);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
  });

  it("releases a run whose gates are all deferred (Waiting) at once, with no grace; a mix with an ordinary gate keeps the grace; off keeps it", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await wait(store, "r0", 0, true);
    await store.mutate("r0", (run) => void (run.gates.push({ ...run.gates[0]!, id: "g2", deferral: null }) as never));
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(true);
    await store.mutate("r0", (run) => void run.gates.pop());
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
    const off = await setup(pacing(", gate_release_after: off"), { current: claude(10) });
    await off.read();
    await off.runtime.startStep("m", "r0", "a", "go");
    await wait(off.store, "r0", 0, true);
    refresh(off.runtime);
    expect(reserved(off.runtime).has("run:r0")).toBe(true);
  });

  it("a gate returned to review takes the reservation back, for a fresh grace", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await wait(store, "r0", 0, true);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
    await store.mutate("r0", (run) => void (run.gates[0]!.deferral!.returnedAt = new Date().toISOString()));
    await (runtime as unknown as { emitReturned(runId: string, gateId: string, by: string, note: string | null, automatic: boolean): Promise<void> }).emitReturned("r0", "g1", "human", null, false);
    expect(reserved(runtime).has("run:r0")).toBe(true);
  });

  it("a returning run goes before runs that never started at the same priority, never before a higher one, and only for a while", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await store.mutate("r1", (run) => void (run.createdAt = ago(500)));
    await wait(store, "r0", 11);
    const inner = runtime as unknown as { rateCandidates(run: unknown): Array<{ run: { id: string } }>; gateReleasedRuns: Map<string, number | null> };
    const order = () => inner.rateCandidates(store.get("r1")!).map((candidate) => candidate.run.id);
    expect(order()).toEqual(["r1"]);
    expect(inner.gateReleasedRuns.get("r0")).toBeNull();
    await decide(store, "r0");
    // r1 is older, but r0 came back from a gate release.
    expect(order()).toEqual(["r0", "r1"]);
    await store.mutate("r1", (run) => void (run.priority = 9));
    expect(order()).toEqual(["r1", "r0"]);
    await store.mutate("r1", (run) => void (run.priority = 0));
    inner.gateReleasedRuns.set("r0", Date.now() - 16 * 60_000);
    expect(order()).toEqual(["r1", "r0"]);
  });

  it("gate_release_after: 0 releases at once, off never, and a duration sets the grace", async () => {
    for (const [extra, released] of [[", gate_release_after: 0", true], [", gate_release_after: off", false], [", gate_release_after: 30m", false]] as const) {
      const { runtime, store, read } = await setup(pacing(extra), { current: claude(10) });
      await read();
      await runtime.startStep("m", "r0", "a", "go");
      await wait(store, "r0", 11);
      refresh(runtime);
      expect(reserved(runtime).has("run:r0"), extra).toBe(!released);
    }
  });

  it("does not release a run that is not waiting: a ready or running step, a fan-out's running step, a human pause, a gate a role decider holds, an after-task running", async () => {
    const { runtime, store, read } = await setup(pacing("") + "\n", { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await wait(store, "r0", 11);
    const gated = async (change: (run: import("../shared/types").Run) => void) => {
      await store.mutate("r0", change);
      refresh(runtime);
      return reserved(runtime).has("run:r0");
    };
    // A step still to run (ready) keeps it.
    expect(await gated((run) => void (run.steps.b!.status = "ready"))).toBe(true);
    await store.mutate("r0", (run) => void (run.steps.b!.status = "pending"));
    expect(await gated((run) => void (run.steps.b!.status = "running"))).toBe(true);
    await store.mutate("r0", (run) => void (run.steps.b!.status = "pending"));
    // A human pause is unchanged.
    expect(await gated((run) => void (run.pausedAt = ago(20)))).toBe(true);
    await store.mutate("r0", (run) => void (run.pausedAt = null));
    // A gate a role decider still holds.
    expect(await gated((run) => void (run.gates[0]!.decider = { by: "role", role: "reviewer" } as never))).toBe(true);
    await store.mutate("r0", (run) => void (run.gates[0]!.decider = { by: "human" }));
    // Finally, waiting: released.
    expect(await gated(() => undefined)).toBe(false);
  });

  it("an exempt run releases its reservation too", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await store.mutate("r0", (run) => void (run.quotaExempt = true));
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    expect(reserved(runtime).has("run:r0")).toBe(true);
    await wait(store, "r0", 11);
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
  });

  it("after a restart (reservations are in memory) a waiting run is not re-reserved, a running one is", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await runtime.startStep("m", "r0", "a", "go");
    await wait(store, "r0", 11);
    reserved(runtime).clear();
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(false);
    await decide(store, "r0");
    refresh(runtime);
    expect(reserved(runtime).has("run:r0")).toBe(true);
  });

  it("is not a candidate of the queue while it waits, so it blocks nobody", async () => {
    const { runtime, store, read } = await setup(pacing(), { current: claude(10) });
    await read();
    await wait(store, "r0", 11);
    const candidates = (runtime as unknown as { rateCandidates(run: unknown): Array<{ run: { id: string } }> }).rateCandidates(store.get("r1")!);
    expect(candidates.map((candidate) => candidate.run.id)).toEqual(["r1"]);
  });
});

describe("quota.gate_release_after resolution", () => {
  it("defaults to 10m; a layer's value (a duration, 0, off) overrides the earlier one, project defaults last", async () => {
    const { DEFAULT_RATE_LIMITS, parseQuotaLimits, resolveQuotaLimits } = await import("./config");
    expect(DEFAULT_RATE_LIMITS.quota.gateReleaseMs).toBe(600_000);
    expect(parseQuotaLimits({ quota: { gate_release_after: "off" } }).quota).toEqual({ gateReleaseMs: null });
    expect(parseQuotaLimits({ quota: { gate_release_after: 0 } }).quota).toEqual({ gateReleaseMs: 0 });
    expect(parseQuotaLimits({ quota: { gate_release_after: "soon" } }).quota).toBeUndefined();
    const user = parseQuotaLimits({ quota: { gate_release_after: "off" } });
    expect(resolveQuotaLimits(user).quota.gateReleaseMs).toBeNull();
    expect(resolveQuotaLimits(user, { quota: { gateReleaseMs: 60_000 } }).quota.gateReleaseMs).toBe(60_000);
    expect(resolveQuotaLimits(undefined, {}).quota.gateReleaseMs).toBe(600_000);
  });
});
