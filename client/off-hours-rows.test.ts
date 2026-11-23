import { describe, expect, it } from "vitest";
import { describeDays, describeRanges, weeklyClosedRows } from "../shared/closed-hours";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { offHoursGroups } from "./off-hours-rows";

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

describe("off hours groups", () => {
  const limits = (closedHours: { timezone: string; slots: Array<{ days: number[]; fromMin: number; toMin: number }> } | null) => ({ repos: ["default"], pacing: false, usablePercent: 90, stepsLimit: null, runsLimit: null, ...(closedHours ? { closedHours, closedKey: JSON.stringify(closedHours), closedNow: { closed: true, changeAt: null } } : {}) });
  const data = (projects: QuotaLimitation["projects"]): QuotaLimitation => ({ now: "2026-11-23T10:00:00Z", projects, stepsRunning: 0, runsActive: 0, providers: [], limitHeld: [] });
  const schedule = { timezone: "UTC", slots: [{ days: [6, 0], fromMin: 0, toMin: 1440 }] };

  it("is empty with no closed hours, even with pacing off", () => {
    expect(offHoursGroups(data([{ projectId: "a", label: "A", limits: [limits(null)] }]))).toEqual([]);
    expect(offHoursGroups(data([]))).toEqual([]);
  });

  it("shows a schedule even when pacing is off, one group for projects that share it", () => {
    const groups = offHoursGroups(data([{ projectId: "a", label: "A", limits: [limits(schedule)] }, { projectId: "b", label: "B", limits: [limits(schedule)] }]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projects).toEqual(["A", "B"]);
    expect(groups[0]!.now).toEqual({ closed: true, changeAt: null });
  });
});
