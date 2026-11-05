import { describe, expect, it } from "vitest";
import { labelLayout } from "./layout";

const STEPS = ["Triage", "Next", "Ticket", "Investigate", "Implement", "Fix", "Babysit", "Review", "Local_qa", "Approval", "Approve", "Lab_ship", "Dev_release", "Dev_qa", "Stg_release", "Stg_qa", "Prd_go", "Prd_release", "Prd_qa", "Loop", "Dismiss", "Done"];

describe("step label layout", () => {
  it("keeps one row when the longest label fits between two ticks", () => {
    expect(labelLayout(1000, ["Backlog", "Research", "Decide", "Done"]).rows).toBe(1);
  });

  it("alternates over two rows when labels would overlap, without boxes wider than two gaps", () => {
    const width = 1000;
    const layout = labelLayout(width, STEPS);
    expect(layout.rows).toBe(2);
    // Labels on the same row are two ticks apart: their boxes must not touch.
    expect(layout.labelWidth).toBeLessThan((2 * width) / (STEPS.length - 1));
  });

  it("never gives a box wider than the default or narrower than a few letters", () => {
    expect(labelLayout(5000, ["A", "B"]).labelWidth).toBeLessThanOrEqual(96);
    expect(labelLayout(100, STEPS).labelWidth).toBeGreaterThanOrEqual(24);
  });
});
