import { describe, expect, it } from "vitest";
import type { RunPriorityView } from "../shared/types";
import { childrenChecked, exemptRequest, pressExempt, applyDraft, applyRequest, commitDraft, draftFor, inheritRequest, isManual, parsePriority, resetRequest, stepDraft, stepped, typeDraft } from "./run-priority";

const view: RunPriorityView = { priority: 2, defaultPriority: 2, override: null, hasChildren: false, inheritChildren: false, exempt: false, inheritChildExempt: false };

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

describe("run priority draft", () => {
  const v: RunPriorityView = { priority: 0, defaultPriority: 0, override: null, hasChildren: false, inheritChildren: false, exempt: false, inheritChildExempt: false };
  it("starts from the effective priority", () => {
    expect(draftFor({ ...v, priority: 3 })).toEqual({ value: 3, text: "3" });
  });
  it("steps from the shown number and the text follows, over repeated presses", () => {
    let d = draftFor(v);
    d = stepDraft(stepDraft(d, -1), -1);
    expect(d).toEqual({ value: -2, text: "-2" });
    d = stepDraft(d, 1);
    expect(d).toEqual({ value: -1, text: "-1" });
  });
  it("clamps at the range", () => {
    expect(stepDraft({ value: 1000, text: "1000" }, 1).text).toBe("1000");
    expect(stepDraft({ value: -1000, text: "-1000" }, -1).text).toBe("-1000");
  });
  it("types: keeps the text, follows when valid, ignores NaN", () => {
    const d = draftFor(v);
    expect(typeDraft(d, "7")).toEqual({ value: 7, text: "7" });
    expect(typeDraft(d, "-")).toEqual({ value: 0, text: "-" });
    expect(typeDraft(d, "abc")).toEqual({ value: 0, text: "abc" });
    expect(typeDraft(d, "5000")).toEqual({ value: 0, text: "5000" });
  });
  it("commits: an invalid text goes back to the number", () => {
    expect(commitDraft({ value: 4, text: "x" })).toEqual({ value: 4, text: "4" });
    expect(commitDraft({ value: 4, text: " 9 " })).toEqual({ value: 9, text: "9" });
  });
  it("applies only a valid, different draft", () => {
    expect(applyDraft("r", v, draftFor(v))).toBeNull();
    expect(applyDraft("r", v, typeDraft(draftFor(v), "x"))).toBeNull();
    expect(applyDraft("r", v, stepDraft(draftFor(v), 1))).toEqual({ runId: "r", priority: 1 });
  });
});

describe("emergency exempt button", () => {
  const exempt: RunPriorityView = { ...view, exempt: true };
  it("needs a second tap to exempt, none to go back", () => {
    expect(pressExempt(view, "idle")).toEqual({ stage: "confirm", send: false });
    expect(pressExempt(view, "confirm")).toEqual({ stage: "idle", send: true });
    expect(pressExempt(exempt, "idle")).toEqual({ stage: "idle", send: true });
  });
  it("sends the opposite state, with the children box only when it was touched on a run with children", () => {
    expect(exemptRequest("r", view, undefined)).toEqual({ runId: "r", exempt: true });
    expect(exemptRequest("r", exempt, undefined)).toEqual({ runId: "r", exempt: false });
    const parent = { ...view, hasChildren: true };
    expect(exemptRequest("r", parent, undefined)).toEqual({ runId: "r", exempt: true });
    expect(exemptRequest("r", parent, true)).toEqual({ runId: "r", exempt: true, applyToChildren: true });
    expect(exemptRequest("r", parent, false)).toEqual({ runId: "r", exempt: true, applyToChildren: false });
    expect(exemptRequest("r", view, true)).toEqual({ runId: "r", exempt: true });
  });
  it("shows the flag of the action the menu is for until the user touches the box", () => {
    expect(childrenChecked({ ...view, inheritChildren: true }, undefined)).toBe(true);
    expect(childrenChecked({ ...exempt, inheritChildren: true, inheritChildExempt: false }, undefined)).toBe(false);
    expect(childrenChecked(exempt, true)).toBe(true);
  });
});
