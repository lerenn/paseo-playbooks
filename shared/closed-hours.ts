/** The closed slots of a project as the Quota tab shows them (ADR 2026-11-23-quota-closed-hours). Days: 0 = Sunday. Minutes from midnight; 1440 = 24:00. */
export interface ClosedSlotView {
  days: number[];
  fromMin: number;
  toMin: number;
}

/** "Sat-Sun" style days: runs of consecutive days (Monday first) joined with a dash. */
function dayRuns(days: number[]): string[][] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const present = order.filter((day) => days.includes(day));
  const runs: number[][] = [];
  for (const day of present) {
    const last = runs[runs.length - 1];
    if (last && order.indexOf(last[last.length - 1]!) + 1 === order.indexOf(day)) last.push(day);
    else runs.push([day]);
  }
  return runs.map((run) => run.map((day) => String(day)));
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** `Sat-Sun, Wed` for a set of days (0 = Sunday), Monday first. */
export function describeDays(days: number[], dayLabel: (day: number) => string): string {
  return dayRuns(days)
    .map((run) => (run.length === 1 ? dayLabel(Number(run[0])) : `${dayLabel(Number(run[0]))}-${dayLabel(Number(run[run.length - 1]))}`))
    .join(", ");
}

/** `00:00-08:00 20:00-24:00` for ranges in minutes from midnight. */
export function describeRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  return ranges.map(([from, to]) => `${clock(from)}-${clock(to)}`).join(" ");
}

/** One line of the weekly list: days sharing the same closed ranges. `allDay`: closed from 00:00 to 24:00 on those days. */
export interface ClosedWeekRow {
  days: number[];
  ranges: Array<[number, number]>;
  allDay: boolean;
}

/**
 * The schedule as a weekly list: per day the closed ranges, overlapping and adjacent ones merged, then days with the same ranges
 * grouped on one row (Monday first). A day with no closed range is not listed.
 */
export function weeklyClosedRows(slots: ClosedSlotView[]): ClosedWeekRow[] {
  const rows = new Map<string, ClosedWeekRow>();
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const sorted = slots
      .filter((slot) => slot.days.includes(day))
      .map((slot): [number, number] => [slot.fromMin, slot.toMin])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    if (merged.length === 0) continue;
    const key = JSON.stringify(merged);
    const row = rows.get(key) ?? { days: [], ranges: merged, allDay: merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === 1440 };
    row.days.push(day);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * A short text of the slots, e.g. `Sat-Sun, Mon 00:00-08:00`: a slot covering the whole day shows only its days. `dayLabel` names a
 * day (0 = Sunday) in the reader's language.
 */
export function describeClosedSlots(slots: ClosedSlotView[], dayLabel: (day: number) => string): string {
  // Slots of the same days (the nested form, or written twice) share one days label: `Mon-Fri 00:00-08:00 20:00-24:00`.
  const groups = new Map<string, { days: number[]; ranges: Array<[number, number]> }>();
  for (const slot of slots) {
    const key = [...slot.days].sort((a, b) => a - b).join(",");
    const group = groups.get(key) ?? { days: slot.days, ranges: [] };
    group.ranges.push([slot.fromMin, slot.toMin]);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ days: dayList, ranges }) => {
      const days = describeDays(dayList, dayLabel);
      if (ranges.some(([from, to]) => from === 0 && to === 1440)) return days;
      return `${days} ${ranges.map(([from, to]) => `${clock(from)}-${clock(to)}`).join(" ")}`;
    })
    .join(", ");
}
