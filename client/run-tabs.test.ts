import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { dotGroups, MAX_TABS, RUN_TONES, runTone, splitTabs } from "./run-tabs";
import { SEMANTIC_DARK, semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/** The fields the tabs and dots read; `age` is hours since the run was created and last updated. */
function run(id: string, status: Run["status"], age = 1, extra: Partial<Run> = {}): Run {
  const at = new Date(NOW - age * HOUR).toISOString();
  return { id, status, createdAt: at, updatedAt: at, seenAt: null, pausedAt: null, after: {}, ...extra } as Run;
}

describe("run tabs", () => {
  it("sorts waiting, running, failed, then done, newest first, and shelves opened runs", () => {
    const runs = [run("done", "completed", 3), run("seen", "completed", 2), run("failed", "failed", 4), run("run", "running", 5), run("gate", "waiting_gate", 6), run("run2", "running", 1)];
    const { tabs, more } = splitTabs(runs, ["seen"], null, NOW);
    expect(tabs.map((r) => r.id)).toEqual(["gate", "run2", "run", "failed", "done"]);
    expect(more.map((r) => r.id)).toEqual(["seen"]);
  });

  it("shelves finished runs after a day even when not opened, but never active ones", () => {
    const runs = [run("old", "completed", 30), run("oldFail", "failed", 30), run("slow", "running", 50)];
    const { tabs, more } = splitTabs(runs, [], null, NOW);
    expect(tabs.map((r) => r.id)).toEqual(["slow"]);
    expect(more.map((r) => r.id)).toEqual(["old", "oldFail"]);
  });

  it("puts the overflow first in History and keeps the selected run's tab", () => {
    const runs = Array.from({ length: MAX_TABS + 2 }, (_, i) => run(`r${i}`, "running", i + 1));
    const shelved = run("seen", "completed", 1, { seenAt: "x" });
    const { tabs, more } = splitTabs([...runs, shelved], [], "seen", NOW);
    expect(tabs).toHaveLength(MAX_TABS + 1);
    expect(tabs.at(-1)!.id).toBe("seen");
    expect(more.map((r) => r.id)).toEqual([`r${MAX_TABS}`, `r${MAX_TABS + 1}`]);
  });
});

describe("run dots", () => {
  it("groups runs by status, most urgent first, and pulses only groups still moving", () => {
    const runs = [run("a", "completed"), run("b", "completed"), run("c", "running", 1, { pausedAt: "x" }), run("d", "waiting_gate"), run("e", "canceled")];
    const groups = dotGroups(runs, ["b"]);
    expect(groups.map((g) => [g.tone, g.runs.map((r) => r.id), g.pulsing])).toEqual([
      ["waiting", ["d"], true],
      ["paused", ["c"], false],
      ["failed", ["e"], false],
      ["done", ["a"], false],
      ["seen", ["b"], false],
    ]);
  });
});

const darkTheme = { colors: { surface1: "#18181b", accent: "#00ff00" } } as unknown as Theme;

describe("paused tone", () => {
  const hold = { kind: "quota", reason: "limit", retryAt: null, provider: null } as unknown as Run["rateHold"];
  it("is the tone of a run paused by hand or on hold, not of a running one", () => {
    expect(runTone(run("a", "running"), false)).toBe("running");
    expect(runTone(run("b", "running", 1, { pausedAt: "x" }), false)).toBe("paused");
    expect(runTone(run("c", "running", 1, { rateHold: hold }), false)).toBe("paused");
    expect(runTone(run("d", "waiting_gate", 1, { rateHold: hold }), false)).toBe("waiting");
    expect(runTone(run("e", "failed", 1, { rateHold: hold }), false)).toBe("failed");
  });
  it("draws a paused run's colour as the fixed violet, a running run's as blue", () => {
    expect(semanticColor(darkTheme, "paused")).toBe(SEMANTIC_DARK.paused.color);
    expect(semanticColor(darkTheme, "paused")).not.toBe(semanticColor(darkTheme, "running"));
  });
  it("sorts paused after running and before failed", () => {
    expect(RUN_TONES.indexOf("paused")).toBe(RUN_TONES.indexOf("running") + 1);
    expect(RUN_TONES.indexOf("paused")).toBeLessThan(RUN_TONES.indexOf("failed"));
  });
});
