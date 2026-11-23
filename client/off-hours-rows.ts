import type { ClosedSlotView } from "../shared/closed-hours";
import type { QuotaLimitation } from "../shared/quota-limitation";

/** One distinct `closed_hours` schedule among the projects, with the projects that use it. */
export interface OffHoursGroup {
  key: string;
  timezone: string;
  slots: ClosedSlotView[];
  projects: string[];
  /** Absent from an older server: the schedule is shown without its state. */
  now?: { closed: boolean; changeAt: string | null };
}

/** The distinct closed-hours schedules of the quota reading (ADR 2026-11-23-off-hours-tab): one group per distinct schedule, projects listed under it. Empty when none is configured. */
export function offHoursGroups(data: QuotaLimitation): OffHoursGroup[] {
  const groups = new Map<string, OffHoursGroup>();
  for (const project of data.projects) {
    for (const limits of project.limits) {
      const closed = limits.closedHours;
      if (!closed || closed.slots.length === 0) continue;
      const key = limits.closedKey ?? JSON.stringify([closed.timezone, closed.slots]);
      const group = groups.get(key) ?? { key, timezone: closed.timezone, slots: closed.slots, projects: [], ...(limits.closedNow ? { now: limits.closedNow } : {}) };
      if (!group.projects.includes(project.label)) group.projects.push(project.label);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}
