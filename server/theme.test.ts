import { describe, expect, it } from "vitest";
import { withAlpha } from "../client/theme";

describe("withAlpha", () => {
  it("tints #rrggbb and #rgb colours", () => {
    expect(withAlpha("#db932e", 0.14)).toBe("#db932e24");
    expect(withAlpha("#fa0", 1)).toBe("#ffaa00ff");
  });
  it("returns null for colours it cannot tint", () => {
    expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBeNull();
    expect(withAlpha("#db932e80", 0.5)).toBeNull();
  });
});
