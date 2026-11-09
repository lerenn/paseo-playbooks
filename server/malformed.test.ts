import { describe, expect, it } from "vitest";
import { repairReport } from "./malformed";

const OUTCOMES = ["approved", "changes_requested"];

describe("repairReport", () => {
  it("passes a well-formed call through", () => {
    const result = repairReport({ outcome: "approved", summary: "ok", outputs: { a: 1 } }, OUTCOMES);
    expect(result).toEqual({ report: { outcome: "approved", summary: "ok", outputs: { a: 1 } }, note: null, error: null });
  });

  it("names a missing summary", () => {
    expect(repairReport({ outcome: "approved", outputs: {} }, OUTCOMES).error).toMatch(/summary is missing/);
  });

  it("salvages an outcome that holds the rest of the call", () => {
    const result = repairReport({ outcome: 'changes_requested</parameter>\n<parameter name="summary">PR needs a test', outputs: {} }, OUTCOMES);
    expect(result.report).toEqual({ outcome: "changes_requested", summary: "PR needs a test", outputs: {} });
    expect(result.note).toMatch(/repaired a malformed/);
  });

  it("salvages outputs written as JSON or YAML in the swallowed parameters", () => {
    const outcome = 'approved</parameter>\n<parameter name="summary">fine</parameter>\n<parameter name="outputs">{"pr_url": "https://x/1"}';
    expect(repairReport({ outcome, outputs: {} }, OUTCOMES).report).toEqual({ outcome: "approved", summary: "fine", outputs: { pr_url: "https://x/1" } });
  });

  it("returns a specific error when it cannot rebuild the call", () => {
    const unknown = repairReport({ outcome: 'bogus</parameter>\n<parameter name="summary">x', outputs: {} }, OUTCOMES);
    expect(unknown.report).toBeNull();
    expect(unknown.error).toMatch(/Your call was malformed: the outcome value contains the other parameters.*exactly one of: approved, changes_requested/);
    const noSummary = repairReport({ outcome: "approved</parameter>", outputs: {} }, OUTCOMES);
    expect(noSummary.error).toMatch(/malformed/);
  });
});
