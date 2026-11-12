import { describe, expect, it } from "vitest";
import { baselineMs, DEFAULT_SLOW_WARNING, keepSlow, slowDetail, slowSteps, type SlowRunView } from "./slow";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function done(id: string, playbook: string, minutes: number, at = 0, status = "completed"): SlowRunView {
  return { id, playbook: { id: playbook, slowWarning: DEFAULT_SLOW_WARNING }, steps: { build: { status, startedAt: iso(at), endedAt: iso(at + minutes) } } };
}

function running(id: string, since: number, warning = DEFAULT_SLOW_WARNING): SlowRunView {
  return { id, playbook: { id: "pr", slowWarning: warning }, steps: { build: { status: "running", startedAt: iso(since), endedAt: null } } };
}

const history = [done("a", "pr", 4, 0), done("b", "pr", 4, 10), done("c", "pr", 4, 20)];

describe("baselineMs", () => {
  it("is the mean of the latest completed runs of the same playbook and step", () => {
    expect(baselineMs(history, "pr", "build", 10, "x")).toBe(4 * 60_000);
    // Only the latest 3 of 4: the oldest (60 min) is dropped.
    expect(baselineMs([done("old", "pr", 60, -100), ...history], "pr", "build", 3, "x")).toBe(4 * 60_000);
  });
  it("needs 3 completed samples, ignores failed ones, other playbooks and the run itself", () => {
    expect(baselineMs(history.slice(0, 2), "pr", "build", 10, "x")).toBeNull();
    expect(baselineMs([...history.slice(0, 2), done("f", "pr", 1, 30, "failed")], "pr", "build", 10, "x")).toBeNull();
    expect(baselineMs([...history.slice(0, 2), done("o", "other", 4, 30)], "pr", "build", 10, "x")).toBeNull();
    expect(baselineMs(history, "pr", "build", 10, "a")).toBeNull();
  });
});

describe("slowSteps", () => {
  const now = (minutes: number) => T0 + minutes * 60_000;
  it("flags a running step once it passes factor times the baseline", () => {
    expect(slowSteps(running("r", 100), history, now(108))).toEqual({});
    const slow = slowSteps(running("r", 100), history, now(112));
    expect(slow.build!.ratio).toBeCloseTo(3);
    expect(slowDetail(slow.build!)).toBe("12m, 3.0x the usual 4m");
  });
  it("flags a finished step by its final duration, and uses the playbook's factor", () => {
    const finished: SlowRunView = { ...running("r", 100), steps: { build: { status: "completed", startedAt: iso(100), endedAt: iso(110) } } };
    expect(Object.keys(slowSteps(finished, history, now(500)))).toEqual(["build"]);
    expect(slowSteps(running("r", 100, { runs: 10, factor: 4 }), history, now(112))).toEqual({});
  });
  it("does not warn without a baseline", () => {
    expect(slowSteps(running("r", 100), history.slice(0, 2), now(500))).toEqual({});
  });
});

describe("keepSlow", () => {
  it("keeps a warning that is no longer computed", () => {
    const info = { elapsedMs: 3, baselineMs: 1, ratio: 3 };
    expect(keepSlow({ build: info }, {})).toEqual({ build: info });
  });
});
