/**
 * Closed hours (ADR 2026-11-23-quota-closed-hours): weekly slots of a project's local time that do not count towards "allowed so far".
 * A closed hour is excluded from both the hours elapsed and the hours in the window, so the allowance stays flat while a slot is closed
 * and the open hours share the whole usable quota. This file is the calendar arithmetic only: the pacing lives in `rate-limit.ts`.
 */

export const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DAY_ALIASES: Record<string, number[]> = {
  weekdays: [1, 2, 3, 4, 5],
  weekend: [6, 0],
  weekends: [6, 0],
  everyday: [0, 1, 2, 3, 4, 5, 6],
  daily: [0, 1, 2, 3, 4, 5, 6],
};
const DAY_ABBREVIATIONS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

/** One closed slot as written: days (0 = Sunday), minutes from midnight; `toMin` may be 1440 (24:00). */
export interface ClosedSlot {
  days: number[];
  fromMin: number;
  toMin: number;
}

/** The closed hours of a project. `timezone` null = the host's timezone. */
export interface ClosedHours {
  timezone: string | null;
  slots: ClosedSlot[];
}

/** The days a name stands for (`monday`, `mon`, `weekdays`, `weekend`), or null when it is none. */
export function dayNumbers(name: string): number[] | null {
  const key = name.trim().toLowerCase();
  const alias = DAY_ALIASES[key];
  if (alias) return alias;
  const index = (DAY_NAMES as readonly string[]).indexOf(key);
  if (index >= 0) return [index];
  const short = DAY_ABBREVIATIONS[key];
  return short === undefined ? null : [short];
}

/** `HH:MM` (`24:00` allowed) as minutes from midnight, or null. */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && minutes <= 1440 ? minutes : null;
}

/** Whether the zone is a known IANA timezone. */
export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timezone, found);
  }
  return found;
}

/** The wall clock of an instant in a zone, as if it were UTC (ms). */
function wallAsUtc(timezone: string, ms: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(ms))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** The instant at which a zone's wall clock reads `wallUtc` (a wall time given as UTC ms). In a spring-forward gap, the instant just after it. */
function instantOfWall(timezone: string, wallUtc: number): number {
  let guess = wallUtc - (wallAsUtc(timezone, wallUtc) - wallUtc);
  const offset = wallAsUtc(timezone, guess) - guess;
  const second = wallUtc - offset;
  if (second !== guess) guess = second;
  return guess;
}

type Interval = [number, number];

/** The closed intervals inside [from, to), sorted and merged. */
export function closedIntervals(closed: ClosedHours, from: number, to: number): Interval[] {
  if (!(to > from) || closed.slots.length === 0) return [];
  const timezone = closed.timezone ?? hostTimezone();
  const first = wallAsUtc(timezone, from);
  const startDay = Math.floor(first / 86_400_000) - 1;
  const out: Interval[] = [];
  for (let day = startDay, guard = 0; guard < 800; day++, guard++) {
    const midnight = day * 86_400_000;
    if (instantOfWall(timezone, midnight) >= to) break;
    const weekday = new Date(midnight).getUTCDay();
    for (const slot of closed.slots) {
      if (!slot.days.includes(weekday)) continue;
      const a = Math.max(from, instantOfWall(timezone, midnight + slot.fromMin * 60_000));
      const b = Math.min(to, instantOfWall(timezone, midnight + slot.toMin * 60_000));
      if (b > a) out.push([a, b]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged: Interval[] = [];
  for (const interval of out) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([interval[0], interval[1]]);
  }
  return merged;
}

/** Milliseconds of [from, to) that are open (not in a closed slot). */
export function openMs(closed: ClosedHours, from: number, to: number): number {
  if (!(to > from)) return 0;
  return to - from - closedIntervals(closed, from, to).reduce((total, [a, b]) => total + (b - a), 0);
}

/** Whether `ms` falls in a closed slot. */
export function isClosedAt(closed: ClosedHours, ms: number): boolean {
  return closedIntervals(closed, ms, ms + 1).length > 0;
}

/** The first instant in [from, to] at which `target` open ms have passed since `from`; `to` when they never do. */
export function instantOfOpenMs(closed: ClosedHours, from: number, to: number, target: number): number {
  let left = Math.max(0, target);
  let cursor = from;
  for (const [a, b] of [...closedIntervals(closed, from, to), [to, to] as Interval]) {
    const gap = a - cursor;
    if (left <= gap) return cursor + left;
    left -= gap;
    cursor = b;
  }
  return to;
}

/** A stable text for a closed-hours setting (to group equal settings), or null when there is none. */
export function closedKey(closed: ClosedHours | null | undefined): string | null {
  if (!closed || closed.slots.length === 0) return null;
  return JSON.stringify([closed.timezone ?? hostTimezone(), closed.slots.map((slot) => [[...slot.days].sort(), slot.fromMin, slot.toMin])]);
}

/**
 * How long ago `from` was at `now`, with closed hours paused (ADR 2026-11-23-closed-hours-shared): the warden's time thresholds count
 * open time only, so nothing fires from time spent closed, and a clock resumes when a slot ends. Without closed hours, plain elapsed time.
 */
export function openAge(closed: ClosedHours | null | undefined, from: number, now: number): number {
  if (!(now > from)) return 0;
  return closed && closed.slots.length > 0 ? openMs(closed, from, now) : now - from;
}

/** How far ahead the next change is looked for: a weekly schedule changes within a week, unless it is closed (or open) throughout. */
const STATE_HORIZON_MS = 8 * 86_400_000;

/**
 * Whether a slot is closed at `nowMs`, and when that next changes (ms): the end of the closed stretch (adjacent and overlapping
 * slots merged) when closed, the start of the next one when open. `changeAt` is null when nothing changes within a week: closed
 * round the clock (the window is fully closed), or no slot at all.
 */
export function closedState(closed: ClosedHours | null | undefined, nowMs: number): { closed: boolean; changeAt: number | null } {
  if (!closed || closed.slots.length === 0) return { closed: false, changeAt: null };
  const end = nowMs + STATE_HORIZON_MS;
  const intervals = closedIntervals(closed, nowMs, end);
  const first = intervals[0];
  if (!first) return { closed: false, changeAt: null };
  if (first[0] <= nowMs) return { closed: true, changeAt: first[1] >= end ? null : first[1] };
  return { closed: false, changeAt: first[0] };
}
