import { z } from "zod";
import { type Run, type Usage, UsageSchema, isAgentlessAttempt } from "./types";

/** One row of a breakdown: what a group of agents spent, and how much of it was thrown away. */
export const UsageRowSchema = z.object({
  /** The name shown. Not unique alone: a manager row shares it with a role or step of the same name, so identify a row by `rowId`. */
  key: z.string(),
  /** True for the run managers' row, whatever its label: a role or step a playbook named like it is another row. */
  manager: z.boolean().default(false),
  /** Context for the key (a step's playbook, role and model). */
  detail: z.string().nullable(),
  runs: z.number().int(),
  attempts: z.number().int(),
  /** Attempts whose work was redone: not the step's last attempt, or one whose agent did not finish. */
  wastedAttempts: z.number().int(),
  usage: UsageSchema,
  /** Tokens (input + output) spent by the wasted attempts. */
  wastedTokens: z.number(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

/** What one agent spent over its life (a manager, a step agent, a decider, any other agent). */
export const AgentUsageSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  /** step, decider, manager, sidekick or other (any agent outside the runs). */
  kind: z.string(),
  role: z.string().nullable(),
  model: z.string().nullable(),
  /** The run it served, if it served one. */
  runId: z.string().nullable(),
  /** Last turn end (ISO). */
  at: z.string(),
  /** Summed per-turn deltas of the agent's cumulative usage; `contextPeak` is its largest context. */
  usage: UsageSchema,
  /** The last cumulative reading, to compute the next delta. */
  last: z.object({
    inputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    contextWindowUsedTokens: z.number().optional(),
  }),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export const AgentRowSchema = AgentUsageSchema.omit({ last: true });
export type AgentRow = z.infer<typeof AgentRowSchema>;

/** The label of the run managers' rows (by role; by step it follows the playbook and a slash). */
export const MANAGER_LABEL = "Playbook Manager";

/** The identity of a row or series: the label, apart for the manager's, which no author-named group can share. */
export function rowId(row: { key: string; manager?: boolean }): string {
  return row.manager ? `\u0000${row.key}` : row.key;
}

/** Tokens (input + output, no cache) per local day for the groups of one breakdown. */
export const DailySeriesSchema = z.object({
  /** Local calendar days (YYYY-MM-DD), oldest first, empty days included. */
  days: z.array(z.string()),
  /** The biggest groups by total, then "Other" (`other: true`) for the rest. `tokens[i]` is for `days[i]`. */
  series: z.array(z.object({ key: z.string(), manager: z.boolean().default(false), other: z.boolean(), total: z.number(), tokens: z.array(z.number()) })),
});
export type DailySeries = z.infer<typeof DailySeriesSchema>;

export const AnalyticsSchema = z.object({
  /** Only runs created at or after this ISO time; null = all runs on disk. */
  since: z.string().nullable(),
  runs: z.number().int(),
  /** Runs with no recorded usage at all (from before usage was recorded). */
  runsWithoutUsage: z.number().int(),
  /** Runs from before usage was recorded as deltas: their manager usage is inflated and left out of the totals. */
  runsWithInvalidManagerUsage: z.number().int().default(0),
  total: UsageSchema,
  byPlaybook: z.array(UsageRowSchema),
  byStep: z.array(UsageRowSchema),
  byRole: z.array(UsageRowSchema),
  byModel: z.array(UsageRowSchema),
  /** Managers and gate deciders: spend outside the steps. */
  overhead: z.object({ manager: UsageSchema, deciders: UsageSchema }),
  /** The agents that spent the most (by tokens), whatever they are; unknown for agents before this was recorded. */
  topAgents: z.array(AgentRowSchema).default([]),
  /** The same breakdowns by day (see `dailySeries`); absent from servers older than the daily graphs. */
  daily: z
    .object({ byPlaybook: DailySeriesSchema, byStep: DailySeriesSchema, byRole: DailySeriesSchema, byModel: DailySeriesSchema })
    .nullable()
    .default(null),
});
export type Analytics = z.infer<typeof AnalyticsSchema>;

export const tokensOf = (usage: Usage): number => usage.inputTokens + usage.outputTokens;

function zero(): Usage {
  return UsageSchema.parse({});
}

function plus(a: Usage, b: Usage | null | undefined): Usage {
  if (!b) return a;
  return {
    turns: a.turns + b.turns,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    contextPeak: Math.max(a.contextPeak, b.contextPeak),
  };
}

/** The local calendar day (YYYY-MM-DD) of an instant in an IANA time zone; UTC when the zone is unknown. */
export function dayKey(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Calendar arithmetic on a YYYY-MM-DD key (no time zone, so no daylight-saving gaps). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Tokens per group and day, from which `dailySeries` builds one chart. */
class Daily {
  private readonly map = new Map<string, Map<string, number>>();
  add(key: string, day: string, tokens: number, manager = false): void {
    if (!day || tokens <= 0) return;
    const id = rowId({ key, manager });
    let days = this.map.get(id);
    if (!days) this.map.set(id, (days = new Map()));
    days.set(day, (days.get(day) ?? 0) + tokens);
  }
  /** `days` oldest first; usage outside them is dropped. The `top` biggest groups stay, the rest fold into "Other". */
  series(days: string[], top: number): DailySeries {
    const rows = [...this.map.entries()]
      .map(([id, byDay]) => {
        const manager = id.startsWith("\u0000");
        const key = manager ? id.slice(1) : id;
        const tokens = days.map((day) => byDay.get(day) ?? 0);
        return { key, manager, other: false, total: tokens.reduce((a, b) => a + b, 0), tokens };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    const kept = rows.slice(0, top);
    const rest = rows.slice(top);
    if (rest.length > 0) {
      const tokens = days.map((_, i) => rest.reduce((sum, row) => sum + row.tokens[i]!, 0));
      kept.push({ key: "Other", manager: false, other: true, total: tokens.reduce((a, b) => a + b, 0), tokens });
    }
    return { days, series: kept };
  }
}

interface Group {
  detail: string | null;
  runs: Set<string>;
  attempts: number;
  wasted: number;
  usage: Usage;
  wastedTokens: number;
}

class Groups {
  private readonly map = new Map<string, Group>();
  add(key: string, detail: string | null, runId: string, usage: Usage, wasted: boolean, manager = false): void {
    const id = rowId({ key, manager });
    let group = this.map.get(id);
    if (!group) this.map.set(id, (group = { detail, runs: new Set(), attempts: 0, wasted: 0, usage: zero(), wastedTokens: 0 }));
    group.runs.add(runId);
    group.attempts += 1;
    group.usage = plus(group.usage, usage);
    if (wasted) {
      group.wasted += 1;
      group.wastedTokens += tokensOf(usage);
    }
  }
  rows(limit: number): UsageRow[] {
    return [...this.map.entries()]
      .map(([id, g]) => ({ key: id.startsWith("\u0000") ? id.slice(1) : id, manager: id.startsWith("\u0000"), detail: g.detail, runs: g.runs.size, attempts: g.attempts, wastedAttempts: g.wasted, usage: g.usage, wastedTokens: g.wastedTokens }))
      .sort((a, b) => tokensOf(b.usage) - tokensOf(a.usage))
      .slice(0, limit);
  }
}

export interface AnalyticsOptions {
  /** Only runs created at or after this ISO time. */
  since?: string | null;
  /** Only runs of this playbook name. */
  playbook?: string | null;
  /** Only runs of this project. */
  projectId?: string | null;
  /** Rows kept per breakdown (default 25). */
  limit?: number;
  /** The per-agent ledger (see server/usage-ledger.ts); the top consumers are drawn from it. */
  agents?: AgentUsage[];
  /** IANA time zone whose midnight ends a day in the daily series (default UTC). */
  timeZone?: string | null;
  /** The instant "today" is taken from (default now). */
  now?: Date;
  /** Groups drawn per daily chart before the rest fold into "Other" (default 5). */
  topSeries?: number;
}

/** Longest span of an all-time daily chart. */
const ALL_TIME_DAYS = 90;

/** Sums the usage recorded in the runs, by playbook, step, role and model. Pure: the caller picks the runs. */
export function analyze(runs: Run[], options: AnalyticsOptions = {}): Analytics {
  const since = options.since ?? null;
  const limit = options.limit ?? 25;
  const picked = runs.filter(
    (run) => (!since || run.createdAt >= since) && (!options.playbook || run.playbook.id === options.playbook) && (!options.projectId || run.projectId === options.projectId),
  );
  const byPlaybook = new Groups();
  const byStep = new Groups();
  const byRole = new Groups();
  const byModel = new Groups();
  let total = zero();
  let manager = zero();
  let deciders = zero();
  let withoutUsage = 0;
  let invalidManager = 0;
  const tz = options.timeZone ?? null;
  const daily = { byPlaybook: new Daily(), byStep: new Daily(), byRole: new Daily(), byModel: new Daily() };
  let firstDay = "";
  const note = (day: string) => {
    if (day && (!firstDay || day < firstDay)) firstDay = day;
  };

  for (const run of picked) {
    let any = false;
    const playbook = run.playbook.id;
    const managerUsage = run.usageDeltas ? run.managerUsage : null;
    if (!run.usageDeltas && run.managerUsage) invalidManager += 1;
    // The manager's usage has no timestamp of its own: it counts on the day the run started.
    const runDay = dayKey(run.createdAt, tz);
    if (managerUsage) {
      daily.byPlaybook.add(playbook, runDay, tokensOf(managerUsage));
      // The manager is its own row in each view: a manager step of its playbook, the manager role, and its model (flagged `manager`, so a step or role a playbook named alike stays apart).
      const managerModel = [run.playbook.manager?.provider, run.playbook.manager?.model].filter(Boolean).join("/") || "default";
      const stepKey = `${playbook}/${MANAGER_LABEL}`;
      const tokens = tokensOf(managerUsage);
      daily.byStep.add(stepKey, runDay, tokens, true);
      daily.byRole.add(MANAGER_LABEL, runDay, tokens, true);
      daily.byModel.add(managerModel, runDay, tokens);
      byStep.add(stepKey, `role ${MANAGER_LABEL}, model ${managerModel}`, run.id, managerUsage, false, true);
      byRole.add(MANAGER_LABEL, null, run.id, managerUsage, false, true);
      byModel.add(managerModel, null, run.id, managerUsage, false);
      note(runDay);
    }
    manager = plus(manager, managerUsage);
    total = plus(total, managerUsage);
    if (managerUsage) any = true;
    for (const gate of run.gates) {
      if (gate.usage) {
        const day = dayKey(gate.decidedAt ?? gate.requestedAt, tz);
        daily.byPlaybook.add(playbook, day, tokensOf(gate.usage));
        note(day);
      }
      deciders = plus(deciders, gate.usage);
      total = plus(total, gate.usage);
      if (gate.usage) any = true;
    }
    let runUsage = plus(plus(zero(), managerUsage), null);
    for (const gate of run.gates) runUsage = plus(runUsage, gate.usage);
    for (const step of run.playbook.steps) {
      const attempts = run.steps[step.id]?.attempts ?? [];
      attempts.forEach((attempt, index) => {
        if (isAgentlessAttempt(attempt.agentId) || !attempt.usage) return;
        any = true;
        const last = index === attempts.length - 1;
        const wasted = !last || (attempt.turnEnd !== null && attempt.turnEnd !== "completed");
        const model = attempt.target || [step.agent.provider, step.agent.model].filter(Boolean).join("/") || "default";
        const day = dayKey(attempt.endedAt ?? attempt.startedAt, tz);
        const tokens = tokensOf(attempt.usage);
        daily.byPlaybook.add(playbook, day, tokens);
        daily.byStep.add(`${playbook}/${step.id}`, day, tokens);
        daily.byRole.add(step.role ?? "(no role)", day, tokens);
        daily.byModel.add(model, day, tokens);
        note(day);
        total = plus(total, attempt.usage);
        runUsage = plus(runUsage, attempt.usage);
        byStep.add(`${playbook}/${step.id}`, `role ${step.role ?? "none"}, model ${model}`, run.id, attempt.usage, wasted);
        byRole.add(step.role ?? "(no role)", null, run.id, attempt.usage, wasted);
        byModel.add(model, null, run.id, attempt.usage, wasted);
      });
    }
    if (!any) withoutUsage += 1;
    byPlaybook.add(playbook, null, run.id, runUsage, false);
  }
  const today = dayKey((options.now ?? new Date()).toISOString(), tz);
  // The day `since` falls on (a partial day) through today; all time starts at the first usage, at most 90 days back.
  let first = since ? dayKey(since, tz) : addDays(today, -(ALL_TIME_DAYS - 1));
  if (!since && firstDay > first) first = firstDay;
  if (first >= today) first = addDays(today, -1);
  const dayList: string[] = [];
  for (let day = first; day <= today; day = addDays(day, 1)) dayList.push(day);
  const top = options.topSeries ?? 5;
  const pickedIds = new Set(picked.map((run) => run.id));
  const filtered = Boolean(options.playbook || options.projectId);
  const topAgents = (options.agents ?? [])
    .filter((agent) => (!since || agent.at >= since) && (!filtered || (agent.runId !== null && pickedIds.has(agent.runId))))
    .map(({ last: _last, ...row }): AgentRow => row)
    .sort((a, b) => b.usage.cachedInputTokens + tokensOf(b.usage) - (a.usage.cachedInputTokens + tokensOf(a.usage)))
    .slice(0, limit);
  return {
    since,
    runs: picked.length,
    runsWithoutUsage: withoutUsage,
    runsWithInvalidManagerUsage: invalidManager,
    total,
    byPlaybook: byPlaybook.rows(limit),
    byStep: byStep.rows(limit),
    byRole: byRole.rows(limit),
    byModel: byModel.rows(limit),
    overhead: { manager, deciders },
    topAgents,
    daily: {
      byPlaybook: daily.byPlaybook.series(dayList, top),
      byStep: daily.byStep.series(dayList, top),
      byRole: daily.byRole.series(dayList, top),
      byModel: daily.byModel.series(dayList, top),
    },
  };
}
