import { describe, expect, it } from "vitest";
import type { RunPriorityView } from "../shared/types";
import { applyRequest, inheritRequest, isManual, parsePriority, resetRequest, stepped } from "./run-priority";

const view: RunPriorityView = { priority: 2, defaultPriority: 2, override: null, hasChildren: false, inheritChildren: false };

describe("run priority control", () => {
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

  it("applies only a valid, changed priority; the flag is sent only for a run with children", () => {
    expect(applyRequest("r", view, "4")).toEqual({ runId: "r", priority: 4 });
    expect(applyRequest("r", view, "2")).toBeNull();
    expect(applyRequest("r", view, "x")).toBeNull();
    expect(applyRequest("r", { ...view, hasChildren: true, inheritChildren: true }, "4")).toEqual({ runId: "r", priority: 4, applyToChildren: true });
  });

  it("reset clears the override", () => {
    expect(resetRequest("r", { ...view, override: 4 })).toEqual({ runId: "r", priority: null });
    expect(resetRequest("r", { ...view, hasChildren: true, override: 4 })).toEqual({ runId: "r", priority: null, applyToChildren: false });
  });

  it("checking applies the current priority to the children; unchecking keeps the override as it is", () => {
    const parent = { ...view, hasChildren: true };
    expect(inheritRequest("r", parent, true)).toEqual({ runId: "r", priority: 2, applyToChildren: true });
    expect(inheritRequest("r", { ...parent, override: 7, inheritChildren: true }, false)).toEqual({ runId: "r", priority: 7, applyToChildren: false });
    expect(inheritRequest("r", parent, false)).toEqual({ runId: "r", priority: null, applyToChildren: false });
  });

  it("knows a manual priority", () => {
    expect(isManual(view)).toBe(false);
    expect(isManual({ ...view, override: 0 })).toBe(true);
  });
});
