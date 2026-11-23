import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** A weekly window with `used` points, 50 of 168 hours gone: what is allowed so far is 28.87 points at 97 usable. */
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
    rateCheck(run: unknown, key?: string, quota?: boolean): Promise<unknown>;
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

  it("is sent again when the kind or the provider and window change", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.apply(verdict({ kind: "headroom" }));
    await s.apply(verdict({ kind: "headroom", window: "five_hour" }));
    await s.apply(verdict({ kind: "headroom", window: "five_hour", provider: "codex" }));
    expect(s.texts()).toHaveLength(4);
  });

  it("is not sent again when a hold is lifted and re-taken with the same kind, provider and window", async () => {
    const s = await spy();
    await s.apply(verdict());
    await s.store.mutate("r1", (run) => void (run.steps.a!.status = "running")); // nothing waits for the manager at the release
    await s.apply(null);
    await s.apply(verdict());
    expect(s.texts()).toHaveLength(1);
  });

  it("a release is told only when the manager knew of the hold and a step now waits for it", async () => {
    const quiet = await spy();
    await quiet.apply(null);
    expect(quiet.texts()).toEqual([]);
    const s = await spy();
    await s.apply(verdict());
    await s.apply(null);
    expect(s.texts()).toHaveLength(2);
    expect(s.texts()[1]).toBe("Rate limit lifted. Ready for you: a.");
    await s.apply(verdict()); // the release reset it: the next hold is told again
    expect(s.texts()).toHaveLength(3);
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
  });
});

describe("quota limits from the playbook defaults, per run", () => {
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
