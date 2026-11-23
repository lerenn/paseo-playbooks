import { describe, expect, it } from "vitest";
import { hasPriority, inheritRequest, parsePriority, resetRequest, setRequest, stepped } from "./quota-priority";

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
