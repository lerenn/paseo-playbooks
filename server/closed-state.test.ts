import { describe, expect, it } from "vitest";
import { parseClosedHours } from "./config";
import { closedState, closedWeek } from "./closed-hours";

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

describe("closed week planner", () => {
  const week = (closed: ReturnType<typeof closedOf>, now: string) => closedWeek(closed, at(now));

  it("lists the week Monday first with merged ranges as clock minutes, today and now", () => {
    // Wednesday 2026-11-25 12:30 UTC.
    const result = week(NIGHTS_AND_WEEKEND, "2026-11-25T12:30:00Z");
    expect(result.today).toBe(3);
    expect(result.nowMin).toBe(750);
    expect(result.days.map((day) => day.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(result.days[0]!.ranges).toEqual([[0, 480], [1200, 1440]]);
    expect(result.days[5]!.ranges).toEqual([[0, 1440]]);
    expect(result.days[6]!.ranges).toEqual([[0, 1440]]);
    expect(result.days.every((day) => day.lengthMin === 1440)).toBe(true);
  });

  it("overlapping and adjacent slots are merged, like the quota and warden see them", () => {
    const overlapping = closedOf({ timezone: "UTC", slots: [{ days: "monday", from: "00:00", to: "09:00" }, { days: "monday", from: "08:00", to: "12:00" }, { days: "monday", from: "12:00", to: "13:00" }] });
    expect(week(overlapping, "2026-11-23T10:00:00Z").days[0]!.ranges).toEqual([[0, 780]]);
  });

  it("reads the day in the schedule's timezone", () => {
    // Sunday 23:30Z is already Monday 00:30 in Paris.
    const paris = closedOf({ timezone: "Europe/Paris", slots: [{ days: "monday", from: "00:00", to: "08:00" }] });
    const result = week(paris, "2026-11-22T23:30:00Z");
    expect(result.today).toBe(1);
    expect(result.nowMin).toBe(30);
    expect(result.days[0]!.ranges).toEqual([[0, 480]]);
  });

  it("no closed slot on a day: an empty list; a window fully closed: every day 00:00-24:00", () => {
    expect(week(WEEKEND, "2026-11-25T12:00:00Z").days[1]!.ranges).toEqual([]);
    const always = closedOf({ timezone: "UTC", slots: [{ days: "everyday", from: "00:00", to: "24:00" }] });
    expect(week(always, "2026-11-25T12:00:00Z").days.every((day) => day.ranges.length === 1 && day.ranges[0]![0] === 0 && day.ranges[0]![1] === 1440)).toBe(true);
  });

  it("daylight saving: the day is 23 or 25 hours long and its ranges stay on the clock", () => {
    const paris = closedOf({ timezone: "Europe/Paris", slots: [{ days: "everyday", slots: [{ from: "00:00", to: "08:00" }, { from: "20:00", to: "24:00" }] }] });
    const spring = week(paris, "2026-03-27T12:00:00Z");
    expect(spring.days.map((day) => day.lengthMin)).toEqual([1440, 1440, 1440, 1440, 1440, 1440, 1380]);
    expect(spring.days[6]!.ranges).toEqual([[0, 480], [1200, 1440]]);
    const autumn = week(paris, "2026-10-23T12:00:00Z");
    expect(autumn.days[6]!.lengthMin).toBe(1500);
    expect(autumn.days[6]!.ranges).toEqual([[0, 480], [1200, 1440]]);
  });
});
