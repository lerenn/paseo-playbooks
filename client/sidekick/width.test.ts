import { describe, expect, it } from "vitest";
import { clampColumnWidth, MIN_COLUMN_WIDTH } from "./width";

describe("clampColumnWidth", () => {
  it("keeps the dragged width between the minimum, with no maximum", () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(5000)).toBe(5000);
    expect(clampColumnWidth(512.4)).toBe(512);
  });
});
