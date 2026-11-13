import { describe, expect, it } from "vitest";
import { runningFor } from "./elapsed";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const start = new Date(T0).toISOString();

describe("runningFor", () => {
  it("is never 0s", () => {
    expect(runningFor(start, T0)).toBe("<1s");
    expect(runningFor(start, T0 + 200)).toBe("<1s");
    expect(runningFor(start, T0 - 5_000)).toBe("<1s");
  });
  it("uses the slow-step format", () => {
    expect(runningFor(start, T0 + 45_000)).toBe("45s");
    expect(runningFor(start, T0 + 12 * 60_000)).toBe("12m");
    expect(runningFor(start, T0 + 65 * 60_000)).toBe("1h05m");
  });
  it("is null without a readable start", () => {
    expect(runningFor(null, T0)).toBeNull();
    expect(runningFor("", T0)).toBeNull();
    expect(runningFor("nope", T0)).toBeNull();
  });
});
