import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RATE_LIMITS, readRateLimitsConfig, resetDeprecationNotes, resolveQuotaLimits, parseQuotaLimits } from "./config";
import { newRun, setRateHold, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { admittedRunIds, limitVerdict, paceCeiling, QuotaPacer, failureReason, roomFreeAt, roomHeadroom, runningStepCount, windowLengthMs, windowRooms } from "./rate-limit";
import type { UsageSnapshot } from "./usage";
import type { Probe } from "./rate-limit";
import type { Run } from "../shared/types";

const temps: string[] = [];
afterEach(async () => void (await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
/** A window of `length` hours with `elapsed` hours gone. */
const windowOf = (id: string, length: number, elapsed: number, usedPct: number) => ({ id, label: id, usedPct, resetsAt: new Date(NOW + (length - elapsed) * HOUR).toISOString() });

describe("allowed so far (pace ceiling)", () => {
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

  it("headroom is what is allowed so far minus usage, and says when it catches up", () => {
    const entry = { providerId: "claude", status: "available", windows: [windowOf("weekly", 168, 84, 60)] };
    const [room] = windowRooms(entry, 97, NOW);
    expect(room!.ceiling).toBeCloseTo(48.5, 5);
    expect(roomHeadroom(room!)).toBeCloseTo(-11.5, 5);
    // 60% is reached by 97 * t / 168 at t = 103.9 h.
    expect(roomFreeAt(room!, 60)! - NOW).toBeCloseTo((60 / 97) * 168 * HOUR - 84 * HOUR, -3);
    expect(roomHeadroom(windowRooms({ ...entry, windows: [windowOf("weekly", 168, 84, 40)] }, 97, NOW)[0]!)).toBeCloseTo(8.5, 5);
  });

  it("never lets the ceiling pass the usable percent; a window of unknown length only has that hard cap", () => {
    const [late] = windowRooms({ providerId: "claude", windows: [windowOf("five_hour", 5, 5, 10)] }, 97, NOW - 1);
    expect(late!.ceiling).toBeLessThanOrEqual(97);
    const [unknown] = windowRooms({ providerId: "claude", windows: [windowOf("mystery", 5, 1, 10)] }, 97, NOW);
    expect(unknown!.ceiling).toBe(97);
    expect(roomFreeAt(unknown!, 50)).toBeNull();
  });

  it("ignores per-model windows, windows that already reset, and windows without usage", () => {
    expect(windowRooms({ providerId: "x", windows: [windowOf("weekly", 168, 169, 99)] }, 97, NOW)).toEqual([]);
    expect(windowRooms({ providerId: "x" }, 97, NOW)).toEqual([]);
    expect(windowRooms({ providerId: "x", windows: [{ id: "weekly", label: "w" }] }, 97, NOW)).toEqual([]);
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
  const unavailable = (probe: Probe) => (probe.state === "unavailable" ? probe.verdict.reason : "");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("holds as unavailable before the first read, then decides from the data", async () => {
    const { quota } = pacer([ok(10)]);
    expect(unavailable(quota.probe("claude", config))).toContain("waiting for quota data on claude");
    await quota.refresh();
    expect(quota.probe("claude", config).state).toBe("ok");
  });

  it("keeps deciding from a stale reading and refreshes once in the background", async () => {
    const t = pacer([ok(10), ok(10)]);
    await t.quota.refresh();
    t.advance(10 * MIN);
    expect(t.quota.probe("claude", config).state).toBe("ok");
    expect(t.quota.probe("claude", config).state).toBe("ok");
    await settle();
    expect(t.calls()).toBe(2);
  });

  it("holds past the max age, does not store a failed read, backs off 1, 2, 5, 10 minutes and releases on success", async () => {
    const down = new Error("down");
    const t = pacer([ok(10), down, down, down, down, down, ok(10)]);
    await t.quota.refresh();
    t.advance(31 * MIN);
    expect(unavailable(t.quota.probe("claude", config))).toContain("waiting for quota data on claude");
    await settle();
    expect(t.calls()).toBe(2);
    // Inside the backoff: no new call.
    t.advance(30_000);
    t.quota.probe("claude", config);
    await settle();
    expect(t.calls()).toBe(2);
    for (const wait of [1, 2, 5, 10, 10]) {
      t.advance(wait * MIN + 1);
      const before = t.calls();
      const verdict = unavailable(t.quota.probe("claude", config));
      await settle();
      if (t.calls() === before + 1 && t.calls() < 7) expect(verdict).toContain("waiting for quota data");
    }
    expect(t.calls()).toBe(7);
    expect(t.quota.probe("claude", config).state).toBe("ok");
    expect(t.changes()).toBe(2);
  });

  it("tracks the provider's usage state: available until reads fail and the reading is past max age, with since, reason and failures", async () => {
    const t = pacer([ok(10), new Error("usage endpoint answered HTTP 429 Too Many Requests"), new Error("HTTP 429"), ok(10)]);
    expect(t.quota.usageState("claude", config)).toMatchObject({ available: true, since: null, lastReadAt: null, failures: 0 });
    await t.quota.refresh();
    const first = NOW;
    t.advance(MIN);
    await t.quota.refresh();
    // A failure inside max age: the reading still decides, so the provider is not unavailable.
    expect(t.quota.usageState("claude", config)).toMatchObject({ available: true, since: null, lastReadAt: first, failures: 1 });
    t.advance(31 * MIN);
    await t.quota.refresh();
    expect(t.quota.usageState("claude", config)).toEqual({ available: false, since: first + MIN, lastReadAt: first, reason: "HTTP 429", failures: 2 });
    expect(t.quota.view(config)[0]!.usage.available).toBe(false);
    t.advance(11 * MIN);
    await t.quota.refresh();
    expect(t.quota.usageState("claude", config)).toMatchObject({ available: true, since: null, reason: null, failures: 0 });
  });

  it("a start-up read that has not ended is not an outage", () => {
    const t = pacer([ok(10)]);
    t.quota.probe("claude", config);
    expect(t.quota.usageState("claude", config).available).toBe(true);
  });

  it("failureReason names the HTTP status, else the first line", () => {
    expect(failureReason(new Error("request failed with status 503"))).toBe("HTTP 503");
    expect(failureReason(new Error("socket hang up\nat x"))).toBe("socket hang up");
    expect(failureReason("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("lets a provider through while it has a continue-anyway override; a provider with no report is unreported", async () => {
    const t = pacer([{ providers: [{ providerId: "claude", windows: [windowOf("weekly", 168, 84, 90)] }, { providerId: "codex", status: "unavailable" }] }]);
    t.quota.probe("claude", config);
    t.quota.probe("codex", config);
    t.quota.probe("other", config);
    await t.quota.refresh();
    expect(t.quota.probe("claude", config).state).toBe("ok");
    expect(t.quota.probe("codex", config).state).toBe("unreported");
    expect(t.quota.probe("other", config).state).toBe("unreported");
    t.quota.override("claude", 10 * MIN);
    expect(t.quota.probe("claude", config).state).toBe("override");
    t.advance(11 * MIN);
    expect(t.quota.probe("claude", config).state).toBe("ok");
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

  it("ignores the removed mode key (either value) and loads the rest", async () => {
    for (const mode of ["step", "playbook", "sometimes"]) {
      expect(await read(`rate_limits: { mode: ${mode}, steps: 4, quota: { pacing: true } }`)).toEqual({ ...DEFAULT_RATE_LIMITS, steps: 4, quota: { ...DEFAULT_RATE_LIMITS.quota, pacing: true } });
    }
  });

  it("reads the block and falls back on malformed values", async () => {
    expect(await read("rate_limits: { steps: 4, playbooks: 2, quota: { pacing: true, usable_percent: 90, refresh_interval: 2m, max_age: 10m } }")).toEqual({ steps: 4, playbooks: 2, quota: { pacing: true, usablePercent: 90, refreshMs: 120_000, maxAgeMs: 600_000 } });
    expect(await read("rate_limits: { steps: 0, playbooks: x, quota: { pacing: yes, usable_percent: 400, max_age: soon } }")).toEqual(DEFAULT_RATE_LIMITS);
  });
});

describe("quota_limits config", () => {
  async function read(yaml: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "ql-config-"));
    temps.push(dir);
    const file = path.join(dir, "config.yaml");
    await writeFile(file, yaml);
    return readRateLimitsConfig(file);
  }

  it("reads quota_limits with the same block keys as the old rate_limits", async () => {
    expect(await read("quota_limits: { steps: 4, playbooks: 2, quota: { pacing: true, usable_percent: 90, refresh_interval: 2m, max_age: 10m } }")).toEqual({ steps: 4, playbooks: 2, quota: { pacing: true, usablePercent: 90, refreshMs: 120_000, maxAgeMs: 600_000 } });
  });

  it("turns pacing on with usable_percent alone, unless pacing is false; the legacy rate_limits keeps needing pacing: true", () => {
    expect(resolveQuotaLimits(parseQuotaLimits({ quota: { usable_percent: 90 } })).quota).toMatchObject({ pacing: true, usablePercent: 90 });
    expect(resolveQuotaLimits(parseQuotaLimits({ quota: { usable_percent: 90, pacing: false } })).quota.pacing).toBe(false);
    expect(resolveQuotaLimits(parseQuotaLimits({ steps: 3 })).quota.pacing).toBe(false);
    expect(resolveQuotaLimits(parseQuotaLimits({ quota: { usable_percent: 90 } }, true)).quota).toMatchObject({ pacing: false, usablePercent: 90 });
  });

  it("keeps rate_limits working as an alias, notes it once, and lets quota_limits win when both are given", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      resetDeprecationNotes();
      expect((await read("rate_limits: { steps: 4 }")).steps).toBe(4);
      expect((await read("rate_limits: { steps: 5 }")).steps).toBe(5);
      expect(warn.mock.calls.filter(([text]) => String(text).includes("`rate_limits` is deprecated") && String(text).includes("`quota_limits`"))).toHaveLength(1);
      expect((await read("rate_limits: { steps: 4, playbooks: 9 }\nquota_limits: { steps: 7 }")).playbooks).toBeNull();
      expect((await read("rate_limits: { steps: 4 }\nquota_limits: { steps: 7 }")).steps).toBe(7);
    } finally {
      warn.mockRestore();
    }
  });

  it("layers fields: built-in, then the user config, then the folder's defaults (a later layer overrides only what it sets)", () => {
    const user = parseQuotaLimits({ steps: 4, quota: { pacing: true, usable_percent: 80, refresh_interval: "2m" } });
    const folder = parseQuotaLimits({ playbooks: 2, quota: { usable_percent: 90 } });
    expect(resolveQuotaLimits(user, folder)).toEqual({ steps: 4, playbooks: 2, quota: { pacing: true, usablePercent: 90, refreshMs: 120_000, maxAgeMs: 30 * 60_000 } });
    expect(resolveQuotaLimits(user, undefined)).toMatchObject({ steps: 4, quota: { usablePercent: 80 } });
    expect(resolveQuotaLimits(undefined, folder).quota).toMatchObject({ pacing: true, usablePercent: 90 });
    expect(resolveQuotaLimits()).toEqual(DEFAULT_RATE_LIMITS);
  });
});
