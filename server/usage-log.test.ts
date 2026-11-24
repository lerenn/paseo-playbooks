import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newRun, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { type UsageLogRow, UsageLogWriter, readUsageLog } from "./usage-log";
import { RunSchema } from "../shared/types";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const temp = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const collect = async (dir: string, range: Parameters<typeof readUsageLog>[1] = {}) => {
  const rows: UsageLogRow[] = [];
  for await (const row of readUsageLog(dir, range)) rows.push(row);
  return rows;
};
const turn = (ts: string, agentId = "a"): UsageLogRow => ({ v: 1, ts, agentId, turnSeq: 1, runId: null, playbook: null, step: null, attempt: null, role: null, tier: null, provider: null, model: null, kind: "other", delta: { input: 1, cacheRead: 2, cacheWrite: null, output: 3 }, contextUsed: 4, costUsd: null, retry: null });

describe("UsageLogWriter and readUsageLog", () => {
  it("appends one line per row to the file of the row's UTC month, and rotates at the boundary without touching the old file", async () => {
    const dir = path.join(await temp("ulog-"), "usage");
    const writer = new UsageLogWriter(dir);
    await writer.append(turn("2026-10-31T23:59:59.999Z"));
    await writer.append(turn("2026-11-01T00:00:00.000Z"));
    await writer.append(turn("2026-11-02T10:00:00.000Z"));
    expect((await readdir(dir)).sort()).toEqual(["usage-2026-10.jsonl", "usage-2026-11.jsonl"]);
    const october = await readFile(path.join(dir, "usage-2026-10.jsonl"), "utf8");
    expect(october.trim().split("\n")).toHaveLength(1);
    await writer.append(turn("2026-10-31T23:59:59.999Z", "late"));
    expect((await readFile(path.join(dir, "usage-2026-10.jsonl"), "utf8")).startsWith(october)).toBe(true);
    expect((await collect(dir)).map((row) => row.ts)).toEqual(["2026-10-31T23:59:59.999Z", "2026-10-31T23:59:59.999Z", "2026-11-01T00:00:00.000Z", "2026-11-02T10:00:00.000Z"]);
  });

  it("serialises concurrent appends: every line is whole", async () => {
    const dir = path.join(await temp("ulog-"), "usage");
    const writer = new UsageLogWriter(dir);
    await Promise.all(Array.from({ length: 200 }, (_, index) => writer.append({ ...turn("2026-11-05T00:00:00Z", `agent-${index}`), model: "x".repeat(2000) })));
    const rows = await collect(dir);
    expect(rows).toHaveLength(200);
    expect(rows.map((row) => (row as { agentId: string }).agentId)).toEqual(Array.from({ length: 200 }, (_, index) => `agent-${index}`));
  });

  it("swallows a failure and reports it once", async () => {
    const root = await temp("ulog-");
    await writeFile(path.join(root, "blocked"), "a file, so the directory cannot be created");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new UsageLogWriter(path.join(root, "blocked", "usage"));
    await expect(writer.append(turn("2026-11-05T00:00:00Z"))).resolves.toBeUndefined();
    await expect(writer.append(turn("2026-11-05T00:00:01Z"))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("filters by range, skips a torn line and returns nothing for a missing directory", async () => {
    const dir = path.join(await temp("ulog-"), "usage");
    const writer = new UsageLogWriter(dir);
    await writer.append(turn("2026-10-15T00:00:00Z"));
    await writer.append(turn("2026-11-15T00:00:00Z"));
    await appendFile(path.join(dir, "usage-2026-11.jsonl"), '{"v":1,"ts":"2026-11-16');
    expect((await collect(dir, { from: "2026-11-01T00:00:00Z" })).map((row) => row.ts)).toEqual(["2026-11-15T00:00:00Z"]);
    expect(await collect(dir, { to: new Date("2026-11-01T00:00:00Z") })).toHaveLength(1);
    expect(await collect(path.join(dir, "nope"))).toEqual([]);
  });
});

const DEFAULTS = `tiers:
  cheap:
    - { provider: claude, model: claude-haiku-5-5 }
    - { provider: codex, model: gpt-5-mini }
manager: { tier: cheap }
`;
const PLAYBOOK = `
title: Release
steps:
  - id: release
    role: { name: implementer, agent: { tier: cheap } }
    outputs: { pr: {} }
`;

async function setup() {
  const dir = await temp("ulog-run-");
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "defaults/main.yaml"), DEFAULTS);
  await writeFile(path.join(root, "release.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "release")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
  startAttempt(run, "release", { agentId: "step-1", brief: "SECRET BRIEF", now: new Date().toISOString(), readonlySnapshot: null });
  run.gates.push({ id: "g1", stepId: "release", status: "pending", deciderAgentId: "dec", decider: { by: "role", role: "advisor" } } as never);
  await store.create(run);
  const readings: Record<string, Record<string, number>> = {};
  const labels: Record<string, Record<string, string>> = { side: { "playbooks/sidekick": "true" } };
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: "claude-haiku-5-5", title: "TITLE", labels: labels[agentId] ?? {}, archivedAt: null, lastUsage: readings[agentId] } }),
    send: async () => undefined,
    reload: async () => null,
  });
  const runtime = new Runtime(store, { autoStartAgents: false, dataDir: dir });
  runtimes.push(runtime);
  await runtime.attach({ agents: { ref } } as never);
  const rows = async () => {
    await runtime.dispose().catch(() => undefined);
    return collect(path.join(dir, "usage"));
  };
  return { dir, store, runtime, readings, rows };
}

/** The usage step of onTurnEnded (the rest of the hook is not under test here). */
const turnEnded = (runtime: Runtime, agentId: string) => (runtime as unknown as { recordUsage(id: string): Promise<void> }).recordUsage(agentId);
const read = (input: number, cached: number, output: number, ctx: number) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, contextWindowUsedTokens: ctx });

describe("the usage log of a runtime", () => {
  it("writes a row per turn for a step, decider, manager, sidekick and other agent, with the tier, and no content", async () => {
    const { runtime, readings, rows } = await setup();
    for (const id of ["step-1", "dec", "m", "side", "free"]) readings[id] = read(10, 100, 5, 1234);
    for (const id of ["step-1", "dec", "m", "side", "free"]) await turnEnded(runtime, id);
    const written = (await rows()) as unknown as Array<Record<string, unknown>>;
    const by = Object.fromEntries(written.map((row) => [row.agentId as string, row]));
    expect(by["step-1"]).toMatchObject({ v: 1, kind: "step", runId: "run_x", playbook: "release", step: "release", attempt: 1, tier: "cheap", provider: "claude", model: "claude-haiku-5-5", turnSeq: 1, retry: null, costUsd: null, contextUsed: 1234, delta: { input: 10, cacheRead: 100, cacheWrite: null, output: 5 } });
    expect(by["dec"]).toMatchObject({ kind: "decider", step: "release", attempt: null, role: "advisor", tier: null });
    expect(by["m"]).toMatchObject({ kind: "manager", step: null, tier: "cheap", runId: "run_x" });
    expect(by["side"]).toMatchObject({ kind: "sidekick", runId: null, playbook: null });
    expect(by["free"]).toMatchObject({ kind: "other", runId: null, role: null, tier: null });
    // Only counters and identifiers: an allowlist of keys, and none of the texts the fakes carry.
    const allowed = ["v", "ts", "agentId", "turnSeq", "runId", "playbook", "step", "attempt", "role", "tier", "provider", "model", "kind", "delta", "contextUsed", "costUsd", "retry"].sort();
    for (const row of written.filter((entry) => entry.type === undefined)) expect(Object.keys(row).sort()).toEqual(allowed);
    expect(JSON.stringify(written)).not.toMatch(/SECRET BRIEF|TITLE/);
  });

  it("logs a cost delta per turn, from the persisted last total, with no totalCostUsd key on the row", async () => {
    const { runtime, readings, rows } = await setup();
    readings.free = { ...read(10, 0, 5, 500), totalCostUsd: 1 };
    await turnEnded(runtime, "free");
    readings.free = { ...read(12, 0, 6, 500), totalCostUsd: 1.5 };
    await turnEnded(runtime, "free");
    const written = ((await rows()) as unknown as Array<Record<string, unknown>>).filter((row) => row.type === undefined);
    expect(written.map((row) => row.costUsd)).toEqual([1, 0.5]);
  });

  it("logs the per-turn delta, which starts over when the counters restart, and counts turns", async () => {
    const { runtime, readings, rows } = await setup();
    readings.free = read(10, 100, 5, 500);
    await turnEnded(runtime, "free");
    readings.free = read(14, 160, 9, 700);
    await turnEnded(runtime, "free");
    readings.free = read(3, 20, 2, 100);
    await turnEnded(runtime, "free");
    const written = (await rows()) as unknown as Array<{ turnSeq: number; delta: unknown; contextUsed: number }>;
    expect(written.map((row) => row.turnSeq)).toEqual([1, 2, 3]);
    expect(written.map((row) => row.delta)).toEqual([
      { input: 10, cacheRead: 100, cacheWrite: null, output: 5 },
      { input: 4, cacheRead: 60, cacheWrite: null, output: 4 },
      { input: 3, cacheRead: 20, cacheWrite: null, output: 2 },
    ]);
    expect(written.map((row) => row.contextUsed)).toEqual([500, 700, 100]);
  });

  it("writes an attempt_end row when an attempt ends, joinable on agent, run, step and attempt", async () => {
    const { store, rows } = await setup();
    await store.mutate("run_x", (run) => {
      const attempt = run.steps.release!.attempts[0]!;
      attempt.endedAt = "2026-11-24T10:00:00.000Z";
      attempt.outcome = "failed";
    });
    expect(await rows()).toEqual([{ v: 1, type: "attempt_end", ts: "2026-11-24T10:00:00.000Z", agentId: "step-1", runId: "run_x", step: "release", attempt: 1, outcome: "failed" }]);
  });
});

describe("the tier of an attempt and the retry mark", () => {
  it("is kept on the attempt and the run's manager, and a run from before it loads", async () => {
    const { store } = await setup();
    const run = store.get("run_x")!;
    expect(run.steps.release!.attempts[0]).toMatchObject({ tier: "cheap", retry: null });
    expect(run.managerTier).toBe("cheap");
    const old = JSON.parse(JSON.stringify(run));
    old.gates = [];
    delete old.managerTier;
    for (const attempt of old.steps.release.attempts) {
      delete attempt.tier;
      delete attempt.retry;
    }
    delete old.steps.release.nextRetry;
    const loaded = RunSchema.parse(old);
    expect(loaded.managerTier).toBeNull();
    expect(loaded.steps.release!.attempts[0]).toMatchObject({ tier: null, retry: null });
  });

  it("marks later attempts: feedback after a goto, recheck after a delayed goto, interrupted after a retry", async () => {
    const { store } = await setup();
    await store.mutate("run_x", (run) => {
      const state = run.steps.release!;
      state.status = "ready";
      startAttempt(run, "release", { agentId: "s2", brief: "", now: "2026-11-24T10:00:00Z", readonlySnapshot: null });
      state.status = "ready";
      state.nextRetry = "recheck";
      startAttempt(run, "release", { agentId: "s3", brief: "", now: "2026-11-24T10:01:00Z", readonlySnapshot: null });
      state.status = "ready";
      state.nextRetry = "feedback";
      startAttempt(run, "release", { agentId: "s4", brief: "", now: "2026-11-24T10:02:00Z", readonlySnapshot: null });
    });
    expect(store.get("run_x")!.steps.release!.attempts.map((attempt) => attempt.retry)).toEqual([null, "interrupted", "recheck", "feedback"]);
    expect(store.get("run_x")!.steps.release!.nextRetry).toBeNull();
  });
});
