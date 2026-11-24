import type { ClosedSlotView } from "../shared/closed-hours";
import type { QuotaLimitation, QuotaProjectLimits } from "../shared/quota-limitation";

/** One distinct `closed_hours` schedule of a project (its playbook sets may differ, like their burn rate limits). */
export interface OffHoursSchedule {
  key: string;
  /** The repositories (`default`, profile ids) whose playbooks have it. */
  repos: string[];
  timezone: string;
  slots: ClosedSlotView[];
  /** Absent from an older server: shown without the state and the planner. */
  now?: { closed: boolean; changeAt: string | null };
  week?: NonNullable<QuotaProjectLimits["closedWeek"]>;
}

/** One row per project, in the order the server sent them (as the Quota tab); `schedules` is empty when the project has no closed hours. */
export interface OffHoursRow {
  projectId: string;
  label: string;
  schedules: OffHoursSchedule[];
}

export function offHoursRows(data: QuotaLimitation): OffHoursRow[] {
  return data.projects.map((project) => {
    const schedules = new Map<string, OffHoursSchedule>();
    for (const limits of project.limits) {
      const closed = limits.closedHours;
      if (!closed || closed.slots.length === 0) continue;
      const key = limits.closedKey ?? JSON.stringify([closed.timezone, closed.slots]);
      const found = schedules.get(key);
      if (found) found.repos.push(...limits.repos);
      else schedules.set(key, { key, repos: [...limits.repos], timezone: closed.timezone, slots: closed.slots, ...(limits.closedNow ? { now: limits.closedNow } : {}), ...(limits.closedWeek ? { week: limits.closedWeek } : {}) });
    }
    return { projectId: project.projectId, label: project.label, schedules: [...schedules.values()] };
  });
}

/** The state shown in a project's collapsed line: the first schedule that is closed now, else the first. Null without closed hours or without a state. */
export function rowState(row: OffHoursRow): OffHoursSchedule | null {
  return row.schedules.find((schedule) => schedule.now?.closed) ?? row.schedules[0] ?? null;
}

/** "08:00" when the instant falls on the same day as `nowIso` in the zone, else "Mon 08:00". */
export function whenLabel(iso: string, nowIso: string, timezone: string, locale: string): string {
  const day = (value: string) => new Date(value).toLocaleDateString("en-CA", { timeZone: timezone });
  const time = new Date(iso).toLocaleTimeString(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (day(iso) === day(nowIso)) return time;
  return `${new Date(iso).toLocaleDateString(locale, { timeZone: timezone, weekday: "short" })} ${time}`;
}

/** The closed stretches of a day as shares (percent) of the 24 h clock. */
export function closedSegments(ranges: ReadonlyArray<readonly [number, number]>): Array<{ left: number; width: number }> {
  return ranges.map(([from, to]) => ({ left: (from / 1440) * 100, width: ((to - from) / 1440) * 100 }));
}

/** The open stretches of a day bar (the ones drawn, in blue) as shares of the 24 h clock: what the closed ranges leave. */
export function openSegments(ranges: ReadonlyArray<readonly [number, number]>): Array<{ left: number; width: number }> {
  const out: Array<{ left: number; width: number }> = [];
  let cursor = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from > cursor) out.push({ left: (cursor / 1440) * 100, width: ((from - cursor) / 1440) * 100 });
    cursor = Math.max(cursor, to);
  }
  if (cursor < 1440) out.push({ left: (cursor / 1440) * 100, width: ((1440 - cursor) / 1440) * 100 });
  return out;
}

/** What a day bar says: closed all day, open all day, or closed in ranges (the text alternative lists them). */
export function dayKind(ranges: ReadonlyArray<readonly [number, number]>): "closedAll" | "openAll" | "ranges" {
  if (ranges.length === 0) return "openAll";
  return ranges.length === 1 && ranges[0]![0] <= 0 && ranges[0]![1] >= 1440 ? "closedAll" : "ranges";
}

/** The hour ticks of a day bar. */
export const HOUR_TICKS = [0, 6, 12, 18, 24] as const;
