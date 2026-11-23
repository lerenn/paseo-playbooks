import { describe, expect, it } from "vitest";
import { parseClosedHours } from "./config";
import { closedState } from "./closed-hours";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const closedOf = (value: unknown) => parseClosedHours(value)!;
const state = (closed: ReturnType<typeof closedOf> | null, now: string) => {
  const result = closedState(closed, at(now));
  return { closed: result.closed, changeAt: iso(result.changeAt) };
};

const WEEKEND = closedOf({ timezone: "UTC", slots: [{ days: "weekend", from: "00:00", to: "24:00" }] });
const WEEKDAY_NIGHTS = closedOf({ timezone: "UTC", slots: [{ days: "weekdays", slots: [{ from: "00:00", to: "08:00" }, { from: "20:00", to: "24:00" }] }] });
const NIGHTS_AND_WEEKEND = closedOf({ timezone: "UTC", slots: [{ days: "weekdays", slots: [{ from: "00:00", to: "08:00" }, { from: "20:00", to: "24:00" }] }, { days: "weekend", from: "00:00", to: "24:00" }] });

describe("closed state now and next change", () => {
  it("weekend: closed on Saturday until Monday 00:00, open on Wednesday until Saturday 00:00", () => {
    expect(state(WEEKEND, "2026-11-21T12:00:00Z")).toEqual({ closed: true, changeAt: "2026-11-23T00:00:00.000Z" });
    expect(state(WEEKEND, "2026-11-25T12:00:00Z")).toEqual({ closed: false, changeAt: "2026-11-28T00:00:00.000Z" });
  });

  it("several ranges on a weekday: the next change is the next range edge, and a closed stretch merges across midnight", () => {
    expect(state(WEEKDAY_NIGHTS, "2026-11-23T10:00:00Z")).toEqual({ closed: false, changeAt: "2026-11-23T20:00:00.000Z" });
    expect(state(WEEKDAY_NIGHTS, "2026-11-23T03:00:00Z")).toEqual({ closed: true, changeAt: "2026-11-23T08:00:00.000Z" });
    // Monday 21:00: the evening range runs into Tuesday's morning range.
    expect(state(WEEKDAY_NIGHTS, "2026-11-23T21:00:00Z")).toEqual({ closed: true, changeAt: "2026-11-24T08:00:00.000Z" });
    // Friday evening runs through the weekend into Monday morning.
    expect(state(NIGHTS_AND_WEEKEND, "2026-11-20T21:00:00Z")).toEqual({ closed: true, changeAt: "2026-11-23T08:00:00.000Z" });
  });

  it("the boundaries: closed at the start instant, open at the end instant", () => {
    expect(state(WEEKEND, "2026-11-21T00:00:00Z").closed).toBe(true);
    expect(state(WEEKEND, "2026-11-23T00:00:00Z")).toEqual({ closed: false, changeAt: "2026-11-28T00:00:00.000Z" });
  });

  it("daylight saving: the slot ends at 08:00 local time on the 23-hour day", () => {
    const paris = closedOf({ timezone: "Europe/Paris", slots: [{ days: "sunday", from: "00:00", to: "08:00" }] });
    // Sunday 2026-03-29, clocks go forward at 02:00: 08:00 CEST is 06:00Z, not 07:00Z.
    expect(state(paris, "2026-03-29T00:30:00Z")).toEqual({ closed: true, changeAt: "2026-03-29T06:00:00.000Z" });
    // Open the day before: the slot starts at local midnight (23:00Z, still CET).
    expect(state(paris, "2026-03-28T12:00:00Z")).toEqual({ closed: false, changeAt: "2026-03-28T23:00:00.000Z" });
    // After the change back (2026-10-25) the day has 25 hours: 08:00 CET is 07:00Z.
    expect(state(paris, "2026-10-25T00:30:00Z")).toEqual({ closed: true, changeAt: "2026-10-25T07:00:00.000Z" });
  });

  it("no config: open, nothing changes", () => {
    expect(state(null, "2026-11-23T10:00:00Z")).toEqual({ closed: false, changeAt: null });
    expect(closedState({ timezone: "UTC", slots: [] }, at("2026-11-23T10:00:00Z"))).toEqual({ closed: false, changeAt: null });
  });

  it("a window fully closed: closed with no change ahead", () => {
    const always = closedOf({ timezone: "UTC", slots: [{ days: "everyday", from: "00:00", to: "24:00" }] });
    expect(state(always, "2026-11-23T10:00:00Z")).toEqual({ closed: true, changeAt: null });
  });
});
