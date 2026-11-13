import { describe, expect, it } from "vitest";
import { addDays, analyze, dayKey } from "./analytics";
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
      expect(chart.series).toEqual([{ key: "opus", other: false, total: 100, tokens: [0, 0, 100, 0] }]);
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
});
