import { describe, expect, it } from "vitest";
import { parseClosedHours, parseQuotaLimits, quotaLimitsLayerOf, resolveQuotaLimits } from "./config";
import { instantOfOpenMs, isClosedAt, openAge, openMs } from "./closed-hours";
import { describeClosedSlots } from "../shared/closed-hours";
import { paceCeiling, roomFreeAt, windowRooms } from "./rate-limit";

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const closedOf = (value: unknown) => parseClosedHours(value)!;
/** A weekly window of 168 h starting at `start`. */
const weekly = (start: string, used = 0) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: new Date(at(start) + 168 * HOUR).toISOString() });

const WEEKEND = closedOf({ timezone: "UTC", slots: [{ days: "weekend", from: "00:00", to: "24:00" }] });
const NIGHTS = closedOf({ timezone: "UTC", slots: [{ days: ["saturday", "sunday"], from: "00:00", to: "24:00" }, { days: ["monday"], from: "00:00", to: "08:00" }] });

describe("closed hours: allowed so far", () => {
  it("weekend case: only open hours accrue, the allowance is flat on the weekend and reaches the usable quota at the end of Friday", () => {
    // Monday 2026-11-16 00:00Z; open time is Mon-Fri = 120 h.
    const win = weekly("2026-11-16T00:00:00Z");
    const ceil = (now: string) => paceCeiling(win, 100, at(now), WEEKEND)!;
    expect(ceil("2026-11-16T12:00:00Z").ceiling).toBeCloseTo(10, 6);
    expect(ceil("2026-11-20T12:00:00Z").ceiling).toBeCloseTo(90, 6);
    expect(ceil("2026-11-21T00:00:00Z").ceiling).toBeCloseTo(100, 6);
    expect(ceil("2026-11-21T12:00:00Z").ceiling).toBeCloseTo(100, 6);
    expect(ceil("2026-11-22T20:00:00Z").ceiling).toBeCloseTo(100, 6);
    expect(ceil("2026-11-21T12:00:00Z").frozen).toBe(true);
    expect(ceil("2026-11-20T12:00:00Z").frozen).toBe(false);
    // The plain rule would have said 4.5/7 of 100 on Friday noon.
    expect(paceCeiling(win, 100, at("2026-11-20T12:00:00Z"))!.ceiling).toBeCloseTo(64.29, 2);
  });

  it("never exceeds the usable quota", () => {
    const win = weekly("2026-11-16T00:00:00Z");
    expect(paceCeiling(win, 97, at("2026-11-23T00:00:00Z"), WEEKEND)!.ceiling).toBeCloseTo(97, 6);
  });

  it("a window reset in the middle of the week counts the open hours of that window only", () => {
    // Wednesday 2026-11-18 15:00Z to Wednesday 25th: closed Sat+Sun (48 h) and Monday 00:00-08:00 (8 h): 112 open hours.
    const win = weekly("2026-11-18T15:00:00Z");
    expect(openMs(NIGHTS, at("2026-11-18T15:00:00Z"), at("2026-11-25T15:00:00Z"))).toBe(112 * HOUR);
    expect(paceCeiling(win, 100, at("2026-11-20T15:00:00Z"), NIGHTS)!.ceiling).toBeCloseTo((48 / 112) * 100, 6);
    // Frozen on Monday at 04:00; after 08:00 it moves again.
    const monday4 = paceCeiling(win, 100, at("2026-11-23T04:00:00Z"), NIGHTS)!;
    const monday8 = paceCeiling(win, 100, at("2026-11-23T08:00:00Z"), NIGHTS)!;
    expect(monday4.frozen).toBe(true);
    expect(monday4.ceiling).toBeCloseTo(monday8.ceiling, 6);
    expect(paceCeiling(win, 100, at("2026-11-23T10:00:00Z"), NIGHTS)!.ceiling).toBeGreaterThan(monday8.ceiling);
  });

  it("follows daylight saving time: a 25 hour Sunday in October, a 23 hour one in March", () => {
    const paris = closedOf({ timezone: "Europe/Paris", slots: [{ days: "sunday", from: "00:00", to: "24:00" }] });
    expect(openMs(paris, at("2026-10-24T00:00:00Z"), at("2026-10-26T00:00:00Z"))).toBe(23 * HOUR);
    expect(openMs(paris, at("2026-03-28T00:00:00Z"), at("2026-03-30T00:00:00Z"))).toBe(25 * HOUR);
    // A fixed local slot keeps its wall clock across the change: Paris 00:00-08:00 is 22:00Z-06:00Z in summer, 23:00Z-07:00Z in winter.
    const night = closedOf({ timezone: "Europe/Paris", slots: [{ days: "everyday", from: "00:00", to: "08:00" }] });
    expect(isClosedAt(night, at("2026-07-01T22:30:00Z"))).toBe(true);
    expect(isClosedAt(night, at("2026-07-01T06:30:00Z"))).toBe(false);
    expect(isClosedAt(night, at("2026-12-01T22:30:00Z"))).toBe(false);
    expect(isClosedAt(night, at("2026-12-01T06:30:00Z"))).toBe(true);
  });

  it("a window with no open hour falls back to the plain linear rule and says so", () => {
    const all = closedOf({ timezone: "UTC", slots: [{ days: "everyday", from: "00:00", to: "24:00" }] });
    const win = weekly("2026-11-16T00:00:00Z", 10);
    const pace = paceCeiling(win, 100, at("2026-11-19T12:00:00Z"), all)!;
    expect(pace.ceiling).toBeCloseTo(50, 6);
    expect(pace.closedIgnored).toBe(true);
    const [room] = windowRooms({ providerId: "claude", windows: [win] }, 100, at("2026-11-19T12:00:00Z"), all);
    expect(room!.closedIgnored).toBe(true);
    expect(Number.isFinite(room!.ceiling)).toBe(true);
  });

  it("slots overlapping are counted once", () => {
    const overlap = closedOf({ timezone: "UTC", slots: [{ days: "monday", from: "00:00", to: "10:00" }, { days: "monday", from: "08:00", to: "12:00" }] });
    expect(openMs(overlap, at("2026-11-16T00:00:00Z"), at("2026-11-17T00:00:00Z"))).toBe(12 * HOUR);
  });

  it("no closed hours: the plain rule, untouched", () => {
    const win = weekly("2026-11-16T00:00:00Z");
    expect(paceCeiling(win, 100, at("2026-11-20T12:00:00Z"), null)!.ceiling).toBeCloseTo(64.29, 2);
    expect(paceCeiling(win, 100, at("2026-11-20T12:00:00Z"), undefined)!.frozen).toBeUndefined();
  });

  it("when the allowance reaches a need: counted in open hours", () => {
    const start = at("2026-11-16T00:00:00Z");
    const [room] = windowRooms({ providerId: "claude", windows: [weekly("2026-11-16T00:00:00Z")] }, 100, start + HOUR, WEEKEND);
    expect(roomFreeAt(room!, 50)).toBe(start + 60 * HOUR);
    expect(roomFreeAt(room!, 90)).toBe(start + 108 * HOUR);
    expect(roomFreeAt(room!, 100)).toBe(start + 168 * HOUR);
    // The inverse of the open-time count, across a closed stretch: 130 open hours of a window do not exist, so the end.
    expect(instantOfOpenMs(WEEKEND, start, start + 168 * HOUR, 130 * HOUR)).toBe(start + 168 * HOUR);
  });
});

describe("closed hours: config", () => {
  it("parses days, aliases and lists, and the timezone (host when absent)", () => {
    const parsed = closedOf({ timezone: "Europe/Paris", slots: [{ days: "weekdays", from: "00:00", to: "08:00" }, { days: ["sat", "Sunday"], from: "00:00", to: "24:00" }] });
    expect(parsed.timezone).toBe("Europe/Paris");
    expect(parsed.slots[0]!.days).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.slots[1]!.days).toEqual([0, 6]);
    expect(parsed.slots[1]!.toMin).toBe(1440);
    expect(closedOf({ slots: [{ days: "monday", from: "1:30", to: "2:00" }] }).timezone).toBeNull();
  });

  it("resolves per layer, a later layer replacing the whole block", () => {
    const user = parseQuotaLimits({ quota: { usable_percent: 90, closed_hours: { timezone: "UTC", slots: [{ days: "weekend", from: "00:00", to: "24:00" }] } } });
    expect(user.quota?.closedHours?.slots).toHaveLength(1);
    const folder = parseQuotaLimits({ quota: { closed_hours: { timezone: "UTC", slots: [{ days: "monday", from: "00:00", to: "08:00" }] } } });
    expect(resolveQuotaLimits(user, folder).quota.closedHours?.slots[0]!.days).toEqual([1]);
    expect(resolveQuotaLimits(user).quota.closedHours).toBeTruthy();
    expect(resolveQuotaLimits().quota.closedHours).toBeUndefined();
  });

  it("reads the shared top-level closed_hours into the quota layer, which wins over quota.closed_hours", () => {
    const top = { timezone: "UTC", slots: [{ days: "weekend", from: "00:00", to: "24:00" }] };
    const layer = quotaLimitsLayerOf({ closed_hours: top })!;
    expect(layer.quota?.closedHours?.slots[0]!.days).toEqual([0, 6]);
    const both = quotaLimitsLayerOf({ quota_limits: { quota: { usable_percent: 80, closed_hours: { slots: [{ days: "monday", from: "00:00", to: "08:00" }] } } }, closed_hours: top })!;
    expect(both.quota?.usablePercent).toBe(80);
    expect(both.quota?.closedHours?.timezone).toBe("UTC");
    expect(quotaLimitsLayerOf({})).toBeUndefined();
  });

  it("describes the slots for the tab", () => {
    const label = (day: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]!;
    expect(describeClosedSlots(NIGHTS.slots, label)).toBe("Sat-Sun, Mon 00:00-08:00");
    expect(describeClosedSlots(closedOf({ slots: [{ days: "weekdays", from: "00:00", to: "08:00" }] }).slots, label)).toBe("Mon-Fri 00:00-08:00");
  });
});

describe("closed hours: several ranges per day group", () => {
  const NESTED = {
    timezone: "UTC",
    slots: [
      { days: ["saturday", "sunday"], slots: [{ from: "00:00", to: "24:00" }] },
      { days: ["monday", "tuesday", "wednesday", "thursday", "friday"], slots: [{ from: "00:00", to: "08:00" }, { from: "20:00", to: "24:00" }] },
    ],
  };
  const FLAT = { timezone: "UTC", slots: [{ days: "weekend", from: "00:00", to: "24:00" }, { days: "weekdays", from: "00:00", to: "08:00" }, { days: "weekdays", from: "20:00", to: "24:00" }] };

  it("a nested list reads as the same slots as the flat form", () => {
    expect(closedOf(NESTED).slots).toHaveLength(3);
    const a = at("2026-11-16T00:00:00Z");
    const b = at("2026-11-23T00:00:00Z");
    expect(openMs(closedOf(NESTED), a, b)).toBe(openMs(closedOf(FLAT), a, b));
    // Weekdays: 12 open hours a day x 5 = 60 h of the 168.
    expect(openMs(closedOf(NESTED), a, b)).toBe(60 * HOUR);
  });

  it("weekday evening + morning: closed 20:00-08:00, open in between", () => {
    const closed = closedOf(NESTED);
    expect(isClosedAt(closed, at("2026-11-17T06:00:00Z"))).toBe(true);
    expect(isClosedAt(closed, at("2026-11-17T12:00:00Z"))).toBe(false);
    expect(isClosedAt(closed, at("2026-11-17T21:00:00Z"))).toBe(true);
    // Friday 20:00 runs straight into the weekend, Monday morning follows it: closed from Friday 20:00 to Monday 08:00.
    expect(openMs(closed, at("2026-11-20T19:00:00Z"), at("2026-11-23T09:00:00Z"))).toBe(2 * HOUR);
    expect(openAge(closed, at("2026-11-17T07:00:00Z"), at("2026-11-17T21:00:00Z"))).toBe(12 * HOUR);
  });

  it("overlapping and adjacent ranges are merged, never counted twice", () => {
    const closed = closedOf({ timezone: "UTC", slots: [{ days: "monday", slots: [{ from: "00:00", to: "10:00" }, { from: "08:00", to: "12:00" }, { from: "12:00", to: "13:00" }] }, { days: "monday", from: "11:00", to: "14:00" }] });
    expect(openMs(closed, at("2026-11-16T00:00:00Z"), at("2026-11-17T00:00:00Z"))).toBe(10 * HOUR);
  });

  it("daylight saving still holds with nested ranges (Europe/Paris, 2026-03-29 is 23 hours)", () => {
    const closed = closedOf({ timezone: "Europe/Paris", slots: [{ days: "everyday", slots: [{ from: "00:00", to: "08:00" }, { from: "20:00", to: "24:00" }] }] });
    // Sunday 2026-03-29: open 08:00-20:00 local, 12 hours, no matter the clock change at 02:00.
    expect(openMs(closed, at("2026-03-28T23:00:00Z"), at("2026-03-29T22:00:00Z"))).toBe(12 * HOUR);
  });

  it("refuses a mixed, empty or incomplete slot (parser)", () => {
    expect(parseClosedHours({ slots: [{ days: "monday", from: "00:00", to: "08:00", slots: [{ from: "09:00", to: "10:00" }] }] })).toBeUndefined();
    expect(parseClosedHours({ slots: [{ days: "monday", slots: [] }] })).toBeUndefined();
    expect(parseClosedHours({ slots: [{ days: "monday", slots: [{ from: "10:00", to: "09:00" }] }] })).toBeUndefined();
  });

  it("the Quota tab text groups the ranges of one day group", () => {
    const label = (day: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]!;
    expect(describeClosedSlots(closedOf(NESTED).slots, label)).toBe("Sat-Sun, Mon-Fri 00:00-08:00 20:00-24:00");
  });
});
