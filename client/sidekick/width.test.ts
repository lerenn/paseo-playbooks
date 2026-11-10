import { describe, expect, it } from "vitest";
import { clampColumnWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "./width";

describe("clampColumnWidth", () => {
  it("keeps the dragged width between the minimum and the maximum", () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(5000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth(512.4)).toBe(512);
  });
});
