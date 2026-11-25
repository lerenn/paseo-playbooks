import { describe, expect, it } from "vitest";
import { addDays, analyze, classifyAttempts, dayKey, sortRows, STALLED_AFTER } from "./analytics";
import { addUsage } from "./types";

const usage = (input: number, output: number) => addUsage(null, { inputTokens: input, outputTokens: output, contextWindowUsedTokens: input });

function run(id: string, attempts: Array<ReturnType<typeof usage>>): any {
  return {
    id,
    createdAt: "2026-11-10T00:00:00Z",
    projectId: "p",
    playbook: { id: "pb", steps: [{ id: "build", role: "dev", agent: { model: "opus" } }] },
    usageDeltas: true,
    managerUsage: usage(5, 5),
    gates: [],
    steps: { build: { attempts: attempts.map((u, i) => ({ agentId: `a${i}`, usage: u, turnEnd: "completed" })) } },
  };
}

describe("analyze", () => {
  it("sums usage by step, role and model and counts earlier attempts as wasted", () => {
    const result = analyze([run("r1", [usage(100, 10), usage(200, 20)])]);
    expect(result.total.inputTokens).toBe(305);
    expect(result.byStep[0]).toMatchObject({ key: "pb/build", attempts: 2, wastedAttempts: 1, wastedTokens: 110 });
    expect(result.byModel[0]!.key).toBe("opus");
    expect(result.byRole[0]!.key).toBe("dev");
    expect(result.overhead.manager.turns).toBe(1);
  });

  it("counts runs with no recorded usage and honors since", () => {
    const old = { ...run("r0", []), createdAt: "2026-01-01T00:00:00Z", managerUsage: undefined };
    expect(analyze([old]).runsWithoutUsage).toBe(1);
    expect(analyze([old], { since: "2026-06-01T00:00:00Z" }).runs).toBe(0);
  });

  it("lists the top agents by tokens, within the window, with their runs filtered like the rest", () => {
    const entry = (agentId: string, tokens: number, at: string, runId: string | null) => ({
      agentId, title: agentId, kind: "other", role: null, model: "claude/opus", runId, at, usage: { ...addUsage(null, { inputTokens: tokens, contextWindowUsedTokens: 9 }) }, last: {},
    });
    const agents = [entry("cheap", 1, "2026-11-10T00:00:00Z", "r1"), entry("drain", 50, "2026-11-10T00:00:00Z", null), entry("old", 99, "2026-01-01T00:00:00Z", null)];
    const all = analyze([run("r1", [])], { agents, since: "2026-06-01T00:00:00Z" });
    expect(all.topAgents.map((row) => row.agentId)).toEqual(["drain", "cheap"]);
    expect(all.topAgents[0]).not.toHaveProperty("last");
    expect(analyze([run("r1", [])], { agents, playbook: "pb" }).topAgents.map((row) => row.agentId)).toEqual(["cheap"]);
  });

  it("leaves out the inflated manager usage of runs from before deltas and counts them", () => {
    const legacy = { ...run("r2", [usage(100, 10)]), usageDeltas: false, managerUsage: usage(1000, 1000) };
    const result = analyze([legacy, run("r3", [])]);
    expect(result.runsWithInvalidManagerUsage).toBe(1);
    expect(result.overhead.manager.turns).toBe(1);
    expect(result.total.inputTokens).toBe(100 + 5);
  });

  describe("daily series", () => {
    const at = (id: string, startedAt: string, endedAt: string | null, model: string, tokens: number): any => {
      const r = run(id, [usage(tokens, 0)]);
      r.managerUsage = null;
      r.createdAt = startedAt;
      r.playbook.steps[0].agent.model = model;
      Object.assign(r.steps.build.attempts[0], { startedAt, endedAt });
      return r;
    };
    const now = new Date("2026-11-13T12:00:00Z");

    it("cuts days at midnight of the given time zone", () => {
      expect(dayKey("2026-11-13T02:00:00Z", "UTC")).toBe("2026-11-13");
      expect(dayKey("2026-11-13T02:00:00Z", "America/Los_Angeles")).toBe("2026-11-12");
      expect(dayKey("2026-11-13T02:00:00Z", "Not/AZone")).toBe("2026-11-13");
      expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    });

    it("draws empty days as zero and counts the attempt on the day it ended", () => {
      const result = analyze([at("r1", "2026-11-11T23:00:00Z", "2026-11-12T01:00:00Z", "opus", 100)], { since: "2026-11-10T12:00:00Z", now, timeZone: "UTC" });
      const chart = result.daily!.byModel;
      expect(chart.days).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
      expect(chart.series).toEqual([{ key: "opus", manager: false, other: false, total: 100, tokens: [0, 0, 100, 0] }]);
    });

    it("moves usage to the previous day for a western time zone", () => {
      const chart = analyze([at("r1", "2026-11-12T01:00:00Z", "2026-11-12T02:00:00Z", "opus", 7)], { since: "2026-11-11T00:00:00Z", now, timeZone: "America/Los_Angeles" }).daily!.byModel;
      expect(chart.days.at(-1)).toBe("2026-11-13");
      expect(chart.series[0]!.tokens[chart.days.indexOf("2026-11-11")]).toBe(7);
    });

    it("folds the groups beyond the top N into Other", () => {
      const runs = ["a", "b", "c", "d"].map((model, i) => at(`r${i}`, "2026-11-13T01:00:00Z", null, model, (4 - i) * 10));
      const chart = analyze(runs, { since: "2026-11-12T00:00:00Z", now, timeZone: "UTC", topSeries: 2 }).daily!.byModel;
      expect(chart.series.map((row) => [row.key, row.other, row.total])).toEqual([["a", false, 40], ["b", false, 30], ["Other", true, 30]]);
    });

    it("spans from the first usage for all time, and 2 days for the last day", () => {
      const r = at("r1", "2026-11-10T01:00:00Z", null, "opus", 1);
      expect(analyze([r], { now, timeZone: "UTC" }).daily!.byModel.days).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
      expect(analyze([r], { since: "2026-11-12T12:00:00Z", now, timeZone: "UTC" }).daily!.byModel.days).toEqual(["2026-11-12", "2026-11-13"]);
    });
  });

  it("counts the manager in the step, role and model views, on the run's creation day", () => {
    const a = run("r1", [usage(100, 10)]);
    a.playbook.manager = { provider: "claude", model: "opus" };
    const b = run("r2", []);
    b.managerUsage = usage(50, 50);
    const result = analyze([a, b], { now: new Date("2026-11-11T12:00:00Z"), timeZone: "UTC" });
    expect(result.byRole.find((row) => row.manager)).toMatchObject({ runs: 2, usage: { inputTokens: 55 } });
    expect(result.byStep.find((row) => row.manager && row.key === "pb/Playbook Manager")).toMatchObject({ runs: 2, wastedAttempts: 0 });
    expect(result.byModel.find((row) => row.key === "claude/opus")!.usage.inputTokens).toBe(5);
    expect(result.byModel.find((row) => row.key === "default")!.usage.inputTokens).toBe(50);
    const seriesOf = (chart: { series: Array<{ key: string; manager: boolean; total: number }> }, key: string, manager = key.endsWith("Playbook Manager")) => chart.series.find((row) => row.manager === manager && row.key === key)?.total;
    expect(seriesOf(result.daily!.byRole, "Playbook Manager")).toBe(110);
    expect(seriesOf(result.daily!.byStep, "pb/Playbook Manager")).toBe(110);
    expect(seriesOf(result.daily!.byPlaybook, "pb")).toBe(110); // the test attempts carry no timestamp, so only the managers are on a day
    // by-playbook still counts it
    expect(result.byPlaybook[0]!.usage.inputTokens).toBe(155);
    // a role and a step a playbook author named like the manager stay apart from it
    const c = run("r3", [usage(1, 1)]);
    c.playbook.steps[0]!.role = "Playbook Manager";
    c.playbook.steps.push({ id: "Playbook Manager", role: "dev", agent: { model: "opus" } });
    c.steps["Playbook Manager"] = { attempts: [{ agentId: "a9", usage: usage(1, 1), turnEnd: "completed" }] };
    c.managerUsage = usage(7, 7);
    const clash = analyze([c], { now: new Date("2026-11-11T12:00:00Z"), timeZone: "UTC" });
    expect(clash.byRole.filter((row) => row.key === "Playbook Manager").map((row) => row.manager).sort()).toEqual([false, true]);
    expect(clash.byStep.filter((row) => row.key === "pb/Playbook Manager").map((row) => row.manager).sort()).toEqual([false, true]);
    const old = run("r4", []);
    old.usageDeltas = false;
    expect(analyze([old]).byRole.find((row) => row.manager)).toBeUndefined();
  });
});

type A = { outcome?: string; summary?: string; turnEnd?: string | null; tokens?: number; report?: boolean };
const attempt = (a: A, i: number) => ({
  agentId: `a${i}`,
  usage: usage(a.tokens ?? 100, 0),
  turnEnd: a.turnEnd === undefined ? "completed" : a.turnEnd,
  outcome: a.outcome ?? "ok",
  report: a.report === false ? null : { outcome: a.outcome ?? "ok", summary: a.summary ?? `s${i}`, outputs: {} },
});
function loopRun(attempts: A[], on: Record<string, any>, gates: any[] = [], id = "r1"): any {
  return {
    id,
    createdAt: "2026-11-10T00:00:00Z",
    projectId: "p",
    playbook: { id: "pb", steps: [{ id: "build", role: "dev", agent: { model: "opus" }, on }] },
    usageDeltas: true,
    managerUsage: usage(5, 5),
    gates,
    steps: { build: { attempts: attempts.map(attempt) } },
  };
}
const stepRow = (r: any) => analyze([r]).byStep.find((row) => !row.manager)!;

describe("repeat passes and lost work", () => {
  it("counts a loop-back attempt as feedback, not lost", () => {
    const row = stepRow(loopRun([{ outcome: "changes_requested" }, { outcome: "approved" }], { changes_requested: { kind: "goto", target: "build" } }));
    expect(row).toMatchObject({ attempts: 2, repeatAttempts: 1, feedbackAttempts: 1, retryAttempts: 0, lostAttempts: 0, lostTokens: 0, lostShare: 0 });
  });

  it("counts a failed attempt that ran again as a retry, and lost", () => {
    const row = stepRow(loopRun([{ outcome: "failure", tokens: 300 }, { outcome: "ok", tokens: 100 }], {}));
    expect(row).toMatchObject({ repeatAttempts: 1, retryAttempts: 1, lostAttempts: 1, lostTokens: 300 });
    expect(row.lostShare).toBeCloseTo(0.75);
  });

  it("counts an attempt whose agent did not finish, or that reported nothing, as interrupted and lost, even the last", () => {
    const row = stepRow(loopRun([{ turnEnd: "canceled", report: false, tokens: 50 }, { report: false, turnEnd: "completed", tokens: 20 }, { turnEnd: "lost", tokens: 10 }], {}));
    expect(row).toMatchObject({ interruptedAttempts: 3, lostAttempts: 3, lostTokens: 80, repeatAttempts: 3 });
  });

  it("counts a timeout as a retry", () => {
    expect(stepRow(loopRun([{ turnEnd: "timeout", report: false }, {}], {}))).toMatchObject({ retryAttempts: 1, interruptedAttempts: 0 });
  });

  it("counts a goto with a delay as a poll: neither feedback nor lost, and never stalled", () => {
    const polls = Array.from({ length: 6 }, () => ({ outcome: "waiting", summary: "still waiting", tokens: 10 }));
    const row = stepRow(loopRun([...polls, { outcome: "ok" }], { waiting: { kind: "goto", target: "build", delayMs: 60000 } }));
    expect(row).toMatchObject({ pollAttempts: 6, feedbackAttempts: 0, lostAttempts: 0, stalledAttempts: 0, repeatAttempts: 6 });
  });

  it("keeps the old fields, equal to the repeat passes", () => {
    const row = stepRow(loopRun([{ outcome: "changes_requested" }, { outcome: "failure" }, { turnEnd: "failed" }], { changes_requested: { kind: "goto", target: "build" } }));
    expect(row.wastedAttempts).toBe(3);
    expect(row.wastedAttempts).toBe(row.repeatAttempts);
    expect(row.wastedTokens).toBe(row.repeatTokens);
    expect(row.repeatAttempts).toBe(row.feedbackAttempts + row.pollAttempts + row.retryAttempts + row.interruptedAttempts);
  });

  it("flags a loop that returns the same outcome and summary STALLED_AFTER times in a row", () => {
    expect(STALLED_AFTER).toBe(3);
    const on = { again: { kind: "goto", target: "build" } };
    const same = (n: number) => Array.from({ length: n }, () => ({ outcome: "again", summary: "same" }));
    expect(stepRow(loopRun([...same(2), { outcome: "ok" }], on)).stalledAttempts).toBe(0);
    const row = stepRow(loopRun([...same(3), { outcome: "ok" }], on));
    expect(row.stalledAttempts).toBe(3);
    expect(row.stalledTokens).toBe(300);
    // a different summary breaks the streak
    expect(stepRow(loopRun([{ outcome: "again", summary: "a" }, { outcome: "again", summary: "b" }, { outcome: "again", summary: "a" }, {}], on)).stalledAttempts).toBe(0);
  });

  it("flags the feedback passes of a loop that reached its limit gate", () => {
    const on = { again: { kind: "goto", target: "build", maxLoops: 2 } };
    const gates = [{ kind: "loop_limit", stepId: "build", usage: null }];
    const row = stepRow(loopRun([{ outcome: "again" }, { outcome: "again", summary: "x" }, { outcome: "again", summary: "y" }], on, gates));
    expect(row.stalledAttempts).toBe(2);
    expect(row.lostAttempts).toBe(0);
  });

  it("never counts a manager row as repeated or lost", () => {
    const result = analyze([loopRun([{ outcome: "failure" }, {}], {})]);
    const manager = result.byStep.find((row) => row.manager)!;
    expect(manager).toMatchObject({ repeatAttempts: 0, wastedAttempts: 0, lostAttempts: 0, lostTokens: 0, lostShare: 0, stalledAttempts: 0 });
    expect(result.byRole.find((row) => row.manager)).toMatchObject({ lostTokens: 0, feedbackAttempts: 0 });
  });

  it("classifies a step's attempts directly", () => {
    const step: any = { on: { x: { kind: "ask", ask: "?", target: "build" } } };
    const attempts = [attempt({ outcome: "x" }, 0), attempt({}, 1)] as any;
    expect(classifyAttempts(step, attempts, false).map((p) => p.kind)).toEqual(["feedback", null]);
  });

  it("counts a finished attempt re-run by another step's goto as feedback or poll, not a retry (ANY-3431)", () => {
    const step: any = { on: {} };
    const withWhy = (why: string | null) => [attempt({ outcome: "fixed" }, 0), { ...attempt({}, 1), retry: why }] as any;
    const kinds = (attempts: any) => classifyAttempts(step, attempts, false).map((p) => p.kind);
    expect(kinds(withWhy("feedback"))).toEqual(["feedback", null]);
    expect(kinds(withWhy("recheck"))).toEqual(["poll", null]);
    expect(kinds(withWhy("interrupted"))).toEqual(["retry", null]);
    // an attempt from before the `retry` field: a finished non-failure outcome was sent back, a failure was retried
    expect(kinds(withWhy(null))).toEqual(["feedback", null]);
    expect(kinds([attempt({ outcome: "failure" }, 0), attempt({}, 1)] as any)).toEqual(["retry", null]);
  });

  it("sorts rows by lost share, then tokens, without touching the order of tokens", () => {
    const low = { usage: usage(500, 0), lostShare: 0.1 };
    const high = { usage: usage(100, 0), lostShare: 0.9 };
    const none = { usage: usage(900, 0), lostShare: 0 };
    const rows = [none, low, high];
    expect(sortRows(rows, "lost")).toEqual([high, low, none]);
    expect(sortRows(rows, "tokens")).toBe(rows);
  });
});

describe("quota rates", () => {
  const rates = [
    { playbook: "pb", provider: "claude", window: "weekly", steps: 8, pointsPerStep: 2, agentMs: 30 * 60_000, pointsPerHour: 8 },
    { playbook: "pb", provider: "claude", window: "session", steps: 2, pointsPerStep: 1, agentMs: 5 * 60_000, pointsPerHour: 12 },
    { playbook: "old", provider: "claude", window: "weekly", steps: 9, pointsPerStep: 1, agentMs: null, pointsPerHour: null },
  ];
  it("exposes points per hour, per step and per finished run, with a low-confidence flag", () => {
    const finished = { ...run("r1", [usage(1, 1), usage(1, 1)]), status: "completed" };
    const result = analyze([finished], { rates });
    const weekly = result.quotaRates.find((rate) => rate.playbook === "pb" && rate.window === "weekly")!;
    expect(weekly).toMatchObject({ burnRate: 8, pointsPerStep: 2, quotaPerRun: 4, steps: 8, agentMs: 30 * 60_000, lowConfidence: false });
    expect(result.quotaRates.find((rate) => rate.window === "session")!.lowConfidence).toBe(true);
    const old = result.quotaRates.find((rate) => rate.playbook === "old")!;
    expect(old).toMatchObject({ burnRate: null, quotaPerRun: null, lowConfidence: true });
    expect(analyze([finished], { rates, playbook: "old" }).quotaRates.map((rate) => rate.playbook)).toEqual(["old"]);
    expect(analyze([finished]).quotaRates).toEqual([]);
  });
});
