import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS, readRateLimitsConfig } from "./config";
import { newRun, setRateHold, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { admittedRunIds, limitVerdict, paceCeiling, QuotaPacer, quotaVerdict, runningStepCount, windowLengthMs } from "./rate-limit";
import type { UsageSnapshot } from "./usage";
import type { Run } from "../shared/types";

const temps: string[] = [];
afterEach(async () => void (await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
/** A window of `length` hours with `elapsed` hours gone. */
const windowOf = (id: string, length: number, elapsed: number, usedPct: number) => ({ id, label: id, usedPct, resetsAt: new Date(NOW + (length - elapsed) * HOUR).toISOString() });

describe("pace ceiling", () => {
  it("reads the window length from its id", () => {
    expect(windowLengthMs({ id: "five_hour" })).toBe(5 * HOUR);
    expect(windowLengthMs({ id: "5h" })).toBe(5 * HOUR);
    expect(windowLengthMs({ id: "weekly" })).toBe(168 * HOUR);
    expect(windowLengthMs({ id: "x", label: "7-day" })).toBe(168 * HOUR);
    expect(windowLengthMs({ id: "mystery" })).toBeNull();
  });

  it("allows 0.97 points an hour on a 100 hour window", () => {
    const pace = paceCeiling({ ...windowOf("w", 100, 10, 0), windowMinutes: 6000 }, 97, NOW)!;
    expect(pace.ceiling).toBeCloseTo(9.7, 5);
  });

  it("holds at or above the ceiling and says when the ceiling catches up", () => {
    const entry = { providerId: "claude", status: "available", windows: [windowOf("weekly", 168, 84, 60)] };
    const held = quotaVerdict(entry, 97, NOW)!;
    expect(held).toMatchObject({ kind: "quota", provider: "claude", window: "weekly" });
    // 60% is reached by 97 * t / 168 at t = 103.9 h: 19.9 h from now.
    expect(Date.parse(held.retryAt!) - NOW).toBeCloseTo((60 / 97) * 168 * HOUR - 84 * HOUR, -3);
    expect(quotaVerdict({ ...entry, windows: [windowOf("weekly", 168, 84, 40)] }, 97, NOW)).toBeNull();
  });

  it("holds everything above the usable percent until the window resets; the tightest window wins", () => {
    const entry = { providerId: "claude", windows: [windowOf("five_hour", 5, 4.9, 97.5), windowOf("weekly", 168, 160, 10)] };
    const held = quotaVerdict(entry, 97, NOW)!;
    expect(held.window).toBe("five_hour");
    expect(held.retryAt).toBe(new Date(NOW + 0.1 * HOUR).toISOString());
  });

  it("ignores a provider that is unavailable, has no window, or a window that already reset", () => {
    expect(quotaVerdict({ providerId: "x", status: "error", windows: [windowOf("weekly", 168, 84, 99)] }, 97, NOW)).toBeNull();
    expect(quotaVerdict({ providerId: "x" }, 97, NOW)).toBeNull();
    expect(quotaVerdict({ providerId: "x", windows: [windowOf("weekly", 168, 169, 99)] }, 97, NOW)).toBeNull();
  });
});

describe("quota cache", () => {
  const config = { pacing: true, usablePercent: 97, refreshMs: 5 * 60_000, maxAgeMs: 30 * 60_000 };
  const MIN = 60_000;
  function pacer(results: Array<UsageSnapshot | Error>) {
    let now = NOW;
    let calls = 0;
    let changes = 0;
    const fetch = async () => {
      const next = results[Math.min(calls++, results.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    };
    const quota = new QuotaPacer(fetch, () => void changes++, () => now);
    return { quota, advance: (ms: number) => void (now += ms), calls: () => calls, changes: () => changes };
  }
  const ok = (used: number): UsageSnapshot => ({ providers: [{ providerId: "claude", windows: [windowOf("weekly", 168, 84, used)] }] });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("holds as unavailable before the first read, then decides from the data", async () => {
    const { quota } = pacer([ok(10)]);
    expect(quota.check(["claude"], config)?.reason).toContain("quota data unavailable");
    await quota.refresh();
    expect(quota.check(["claude"], config)).toBeNull();
  });

  it("keeps deciding from a stale reading and refreshes once in the background", async () => {
    const t = pacer([ok(10), ok(10)]);
    await t.quota.refresh();
    t.advance(10 * MIN);
    expect(t.quota.check(["claude"], config)).toBeNull();
    expect(t.quota.check(["claude"], config)).toBeNull();
    await settle();
    expect(t.calls()).toBe(2);
  });

  it("holds past the max age, does not store a failed read, backs off 1, 2, 5, 10 minutes and releases on success", async () => {
    const down = new Error("down");
    const t = pacer([ok(10), down, down, down, down, down, ok(10)]);
    await t.quota.refresh();
    t.advance(31 * MIN);
    expect(t.quota.check(["claude"], config)?.reason).toContain("quota data unavailable");
    await settle();
    expect(t.calls()).toBe(2);
    // Inside the backoff: no new call.
    t.advance(30_000);
    t.quota.check(["claude"], config);
    await settle();
    expect(t.calls()).toBe(2);
    for (const wait of [1, 2, 5, 10, 10]) {
      t.advance(wait * MIN + 1);
      const before = t.calls();
      const verdict = t.quota.check(["claude"], config);
      await settle();
      if (t.calls() === before + 1 && t.calls() < 7) expect(verdict?.reason).toContain("unavailable");
    }
    expect(t.calls()).toBe(7);
    expect(t.quota.check(["claude"], config)).toBeNull();
    expect(t.changes()).toBe(2);
  });

  it("lets a provider through while it has a continue-anyway override, and the tightest provider wins", async () => {
    const t = pacer([{ providers: [{ providerId: "claude", windows: [windowOf("weekly", 168, 84, 90)] }, { providerId: "codex", windows: [windowOf("weekly", 168, 84, 95)] }] }]);
    t.quota.check(["claude", "codex"], config);
    await t.quota.refresh();
    expect(t.quota.check(["claude", "codex"], config)?.provider).toBe("codex");
    t.quota.override("codex", 10 * MIN);
    expect(t.quota.check(["claude", "codex"], config)?.provider).toBe("claude");
    t.advance(11 * MIN);
    expect(t.quota.check(["codex"], config)?.provider).toBe("codex");
  });
});

describe("global limits", () => {
  const PLAYBOOK = `
title: Work
steps:
  - id: a
    role: { name: implementer, agent: { provider: claude, model: m } }
  - id: b
    needs: [a]
    role: { name: implementer, agent: { provider: claude, model: m } }
`;
  async function mk(count: number): Promise<Run[]> {
    const dir = await mkdtemp(path.join(tmpdir(), "limits-"));
    temps.push(dir);
    const root = path.join(dir, ".paseo/playbooks");
    await mkdir(path.join(root, "roles/implementer"), { recursive: true });
    await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
    await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
    await writeFile(path.join(root, "work.yaml"), PLAYBOOK);
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "work")!;
    expect(entry.errors).toEqual([]);
    return Array.from({ length: count }, (_, i) => newRun({ id: `r${i}`, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date(NOW + i * 1000).toISOString() }));
  }

  it("holds a step when the step limit is full and counts only running agent and script steps", async () => {
    const runs = await mk(2);
    expect(limitVerdict(runs[0]!, runs, { steps: 1, playbooks: null }, 0)).toBeNull();
    startAttempt(runs[1]!, "a", { agentId: "x", brief: "", now: new Date(NOW).toISOString(), readonlySnapshot: null });
    expect(runningStepCount(runs)).toBe(1);
    expect(limitVerdict(runs[0]!, runs, { steps: 1, playbooks: null }, 0)).toMatchObject({ kind: "steps" });
    expect(limitVerdict(runs[0]!, runs, { steps: 2, playbooks: null }, 0)).toBeNull();
    // A step being started counts too.
    expect(limitVerdict(runs[0]!, runs, { steps: 2, playbooks: null }, 1)).toMatchObject({ kind: "steps" });
  });

  it("admits the oldest runs: the youngest is held between steps and stays held, never alternating", async () => {
    const runs = await mk(2);
    expect([...admittedRunIds(runs, 1)!]).toEqual(["r0"]);
    expect(limitVerdict(runs[1]!, runs, { steps: null, playbooks: 1 }, 0)).toMatchObject({ kind: "playbooks" });
    expect(limitVerdict(runs[0]!, runs, { steps: null, playbooks: 1 }, 0)).toBeNull();
    // Another look gives the same answer: no alternation.
    expect([...admittedRunIds(runs, 1)!]).toEqual(["r0"]);
    // A step of the held run that is running is never interrupted: it only waits for its next one.
    startAttempt(runs[1]!, "a", { agentId: "x", brief: "", now: new Date(NOW).toISOString(), readonlySnapshot: null });
    expect(limitVerdict(runs[1]!, runs, { steps: null, playbooks: 1 }, 0)).toBeNull();
    // The limit rises, or the other run ends: the held run is admitted.
    expect([...admittedRunIds(runs, 2)!].sort()).toEqual(["r0", "r1"]);
    runs[0]!.status = "completed";
    expect([...admittedRunIds(runs, 1)!]).toEqual(["r1"]);
    expect(admittedRunIds(runs, null)).toBeNull();
  });

  it("records a hold once and its end", async () => {
    const [run] = await mk(1);
    const hold = { kind: "quota" as const, reason: "claude weekly high", provider: "claude", window: "weekly", retryAt: null };
    expect(setRateHold(run!, hold, "t1")).toBe("held");
    expect(setRateHold(run!, { ...hold, reason: "claude weekly higher" }, "t2")).toBeNull();
    expect(run!.rateHold).toMatchObject({ since: "t1", reason: "claude weekly higher" });
    expect(setRateHold(run!, null, "t3")).toBe("released");
    expect(setRateHold(run!, null, "t4")).toBeNull();
    expect(run!.history.map((entry) => entry.type)).toEqual(expect.arrayContaining(["run_held", "run_released"]));
  });
});

describe("rate_limits config", () => {
  async function read(yaml: string | null) {
    const dir = await mkdtemp(path.join(tmpdir(), "rl-config-"));
    temps.push(dir);
    const file = path.join(dir, "config.yaml");
    if (yaml !== null) await writeFile(file, yaml);
    return readRateLimitsConfig(file);
  }

  it("is off by default", async () => {
    expect(await read(null)).toEqual(DEFAULT_RATE_LIMITS);
    expect(DEFAULT_RATE_LIMITS).toMatchObject({ steps: null, playbooks: null, quota: { pacing: false, usablePercent: 97 } });
  });

  it("reads the block and falls back on malformed values", async () => {
    expect(await read("rate_limits: { steps: 4, playbooks: 2, quota: { pacing: true, usable_percent: 90, refresh_interval: 2m, max_age: 10m } }")).toEqual({ steps: 4, playbooks: 2, quota: { pacing: true, usablePercent: 90, refreshMs: 120_000, maxAgeMs: 600_000 } });
    expect(await read("rate_limits: { steps: 0, playbooks: x, quota: { pacing: yes, usable_percent: 400, max_age: soon } }")).toEqual(DEFAULT_RATE_LIMITS);
  });
});
