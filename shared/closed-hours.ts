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

/**
 * A short text of the slots, e.g. `Sat-Sun, Mon 00:00-08:00`: a slot covering the whole day shows only its days. `dayLabel` names a
 * day (0 = Sunday) in the reader's language.
 */
export function describeClosedSlots(slots: ClosedSlotView[], dayLabel: (day: number) => string): string {
  return slots
    .map((slot) => {
      const days = dayRuns(slot.days)
        .map((run) => (run.length === 1 ? dayLabel(Number(run[0])) : `${dayLabel(Number(run[0]))}-${dayLabel(Number(run[run.length - 1]))}`))
        .join(", ");
      return slot.fromMin === 0 && slot.toMin === 1440 ? days : `${days} ${clock(slot.fromMin)}-${clock(slot.toMin)}`;
    })
    .join(", ");
}
