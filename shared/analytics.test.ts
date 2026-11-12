import { describe, expect, it } from "vitest";
import { analyze } from "./analytics";
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
});
