import { describe, expect, it } from "vitest";
import type { Theme } from "./theme";
import { priorityLineColors, hasPriority, inheritRequest, parsePriority, resetRequest, setRequest, stepped } from "./quota-priority";

const run = { runId: "r", title: "Work", priority: 2, defaultPriority: 2, override: null as number | null, hasChildren: false, inheritChildren: false };

describe("quota priority control", () => {
  it("parses only whole numbers in the playbook's range", () => {
    expect(parsePriority(" 5 ")).toBe(5);
    expect(parsePriority("-1000")).toBe(-1000);
    expect(parsePriority("1001")).toBeNull();
    expect(parsePriority("1.5")).toBeNull();
    expect(parsePriority("")).toBeNull();
    expect(parsePriority("abc")).toBeNull();
  });

  it("steps within the range", () => {
    expect(stepped(1000, 1)).toBe(1000);
    expect(stepped(-1000, -1)).toBe(-1000);
    expect(stepped(0, 1)).toBe(1);
  });

  it("sends the checkbox flag only for a run with children", () => {
    expect(setRequest(run, 4, true)).toEqual({ runId: "r", priority: 4 });
    expect(setRequest({ ...run, hasChildren: true }, 4, true)).toEqual({ runId: "r", priority: 4, applyToChildren: true });
    expect(resetRequest({ ...run, hasChildren: true, override: 4 }, false)).toEqual({ runId: "r", priority: null, applyToChildren: false });
  });

  it("checking applies the current priority to the children; unchecking keeps the override as it is", () => {
    const parent = { ...run, hasChildren: true };
    expect(inheritRequest(parent, true)).toEqual({ runId: "r", priority: 2, applyToChildren: true });
    expect(inheritRequest({ ...parent, override: 7, inheritChildren: true }, false)).toEqual({ runId: "r", priority: 7, applyToChildren: false });
    expect(inheritRequest(parent, false)).toEqual({ runId: "r", priority: null, applyToChildren: false });
  });

  it("hides the control for a server that does not send the priority", () => {
    expect(hasPriority({ runId: "r", title: "Work" })).toBe(false);
    expect(hasPriority(run)).toBe(true);
  });
});

describe("priority line colours", () => {
  const theme = { colors: { surface1: "#18181b", accent: "#00ff00", foregroundMuted: "#999999" } } as unknown as Theme;
  it("draws the held and paused tag in the paused violet", () => {
    expect(priorityLineColors(theme, false).tag).toBe("#a78bfa");
    expect(priorityLineColors(theme, true).tag).toBe("#a78bfa");
  });
  it("marks a manual priority with the accent, neither orange nor violet, and a default one muted", () => {
    expect(priorityLineColors(theme, true).priority).toBe("#00ff00");
    expect(priorityLineColors(theme, false).priority).toBe("#999999");
  });
});
