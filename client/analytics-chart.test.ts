import { describe, expect, it } from "vitest";
import { axisTicks, compactNumber, isDarkColor, labelIndexes, niceAxis, seriesColor, shortDate } from "./analytics-chart";

describe("analytics chart helpers", () => {
  it("abbreviates numbers", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1200)).toBe("1.2k");
    expect(compactNumber(12_000)).toBe("12k");
    expect(compactNumber(1_234_567)).toBe("1.2M");
  });
  it("picks round axis ticks covering the peak", () => {
    expect(axisTicks(1_150_000)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
    expect(axisTicks(900)).toEqual([0, 500, 1000]);
    expect(niceAxis(7).top).toBeGreaterThanOrEqual(7);
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(1)).toEqual([0, 0.5, 1]);
  });
  it("formats dates", () => {
    expect(shortDate("2026-11-03")).toBe("Nov 3");
    expect(shortDate("weird")).toBe("weird");
  });
  it("labels the start, middle and end", () => {
    expect(labelIndexes(0)).toEqual([]);
    expect(labelIndexes(1)).toEqual([0]);
    expect(labelIndexes(2)).toEqual([0, 1]);
    expect(labelIndexes(7)).toEqual([0, 3, 6]);
    expect(labelIndexes(90)).toEqual([0, 44, 89]);
  });
  it("assigns colours by slot, per mode", () => {
    expect(seriesColor(0, false)).not.toBe(seriesColor(0, true));
    expect(seriesColor(5, false)).toBe(seriesColor(0, false));
  });
  it("tells dark from light", () => {
    expect(isDarkColor("#1a1a19")).toBe(true);
    expect(isDarkColor("#fcfcfb")).toBe(false);
    expect(isDarkColor("#000")).toBe(true);
    expect(isDarkColor("rgb(0,0,0)")).toBe(false);
  });
});
