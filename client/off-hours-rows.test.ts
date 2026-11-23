import { describe, expect, it } from "vitest";
import { describeDays, describeRanges, weeklyClosedRows } from "../shared/closed-hours";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { closedSegments, dayKind, openSegments, offHoursRows, rowState, whenLabel } from "./off-hours-rows";

const label = (day: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]!;
const text = (slots: Parameters<typeof weeklyClosedRows>[0]) => weeklyClosedRows(slots).map((row) => `${describeDays(row.days, label)}: ${row.allDay ? "all day" : describeRanges(row.ranges)}`);

describe("weekly list of closed slots", () => {
  it("groups days with the same ranges and merges overlapping and adjacent ranges", () => {
    expect(
      text([
        { days: [1, 2, 3, 4, 5], fromMin: 0, toMin: 480 },
        { days: [1, 2, 3, 4, 5], fromMin: 1200, toMin: 1440 },
        { days: [1, 2, 3, 4, 5], fromMin: 420, toMin: 540 },
        { days: [6, 0], fromMin: 0, toMin: 720 },
        { days: [6, 0], fromMin: 720, toMin: 1440 },
      ]),
    ).toEqual(["Mon-Fri: 00:00-09:00 20:00-24:00", "Sat-Sun: all day"]);
  });

  it("lists a day with its own ranges apart", () => {
    expect(text([{ days: [1, 2], fromMin: 0, toMin: 480 }, { days: [2], fromMin: 1200, toMin: 1440 }])).toEqual(["Mon: 00:00-08:00", "Tue: 00:00-08:00 20:00-24:00"]);
  });
});

describe("off hours rows", () => {
  type Limits = QuotaLimitation["projects"][number]["limits"][number];
  const hours = (timezone: string) => ({ timezone, slots: [{ days: [6, 0], fromMin: 0, toMin: 1440 }] });
  const limits = (repos: string[], closedHours: Limits["closedHours"], closed = false): Limits => ({ repos, pacing: false, usablePercent: 90, stepsLimit: null, runsLimit: null, ...(closedHours ? { closedHours, closedKey: JSON.stringify(closedHours), closedNow: { closed, changeAt: null } } : {}) });
  const data = (projects: QuotaLimitation["projects"]): QuotaLimitation => ({ now: "2026-11-23T10:00:00Z", projects, stepsRunning: 0, runsActive: 0, providers: [], limitHeld: [] });

  it("one row per project in the server's order; a project without closed hours is listed with no schedule, pacing or not", () => {
    const rows = offHoursRows(data([{ projectId: "a", label: "A", limits: [limits(["default"], null)] }, { projectId: "b", label: "B", limits: [limits(["default"], hours("UTC"))] }]));
    expect(rows.map((row) => [row.label, row.schedules.length])).toEqual([["A", 0], ["B", 1]]);
    expect(rowState(rows[0]!)).toBeNull();
    expect(offHoursRows(data([]))).toEqual([]);
  });

  it("each project has its own schedule and timezone; sets with the same schedule are one, different ones are listed", () => {
    const rows = offHoursRows(data([
      { projectId: "a", label: "A", limits: [limits(["default"], hours("UTC")), limits(["p1"], hours("UTC"))] },
      { projectId: "b", label: "B", limits: [limits(["default"], hours("Europe/Paris")), limits(["p1"], hours("Asia/Tokyo"))] },
    ]));
    expect(rows[0]!.schedules).toHaveLength(1);
    expect(rows[0]!.schedules[0]!.repos).toEqual(["default", "p1"]);
    expect(rows[1]!.schedules.map((schedule) => schedule.timezone)).toEqual(["Europe/Paris", "Asia/Tokyo"]);
  });

  it("the collapsed state is the first schedule that is closed now", () => {
    const rows = offHoursRows(data([{ projectId: "a", label: "A", limits: [limits(["default"], hours("UTC")), limits(["p1"], hours("Asia/Tokyo"), true)] }]));
    expect(rowState(rows[0]!)!.timezone).toBe("Asia/Tokyo");
  });
});

describe("collapsed time labels", () => {
  it("shows the time alone on the same day in the zone, the weekday and time otherwise", () => {
    expect(whenLabel("2026-11-23T20:00:00Z", "2026-11-23T10:00:00Z", "UTC", "en")).toBe("20:00");
    expect(whenLabel("2026-11-24T08:00:00Z", "2026-11-23T10:00:00Z", "UTC", "en")).toBe("Tue 08:00");
    // 23:30Z is already Tuesday in Paris (CET).
    expect(whenLabel("2026-11-23T23:30:00Z", "2026-11-23T10:00:00Z", "Europe/Paris", "en")).toBe("Tue 00:30");
  });
});

describe("planner bars", () => {
  it("draws the closed ranges as shares of the 24 h clock", () => {
    expect(closedSegments([[0, 480], [1200, 1440]])).toEqual([{ left: 0, width: (480 / 1440) * 100 }, { left: (1200 / 1440) * 100, width: (240 / 1440) * 100 }]);
    expect(closedSegments([])).toEqual([]);
  });

  it("draws the open stretches (the blue ones) as what the closed ranges leave", () => {
    expect(openSegments([[0, 480], [1200, 1440]])).toEqual([{ left: 480 / 1440 * 100, width: 720 / 1440 * 100 }]);
    expect(openSegments([])).toEqual([{ left: 0, width: 100 }]);
    expect(openSegments([[0, 1440]])).toEqual([]);
    expect(openSegments([[360, 720], [720, 1080]])).toEqual([{ left: 0, width: 25 }, { left: 75, width: 25 }]);
  });

  it("tells closed all day, open all day and ranges apart (the text alternative)", () => {
    expect(dayKind([[0, 1440]])).toBe("closedAll");
    expect(dayKind([])).toBe("openAll");
    expect(dayKind([[0, 480], [1200, 1440]])).toBe("ranges");
    expect(dayKind([[0, 1380]])).toBe("ranges");
  });
});
