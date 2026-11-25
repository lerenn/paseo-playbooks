import { z } from "zod";
import { type Attempt, type Run, type Step, type Usage, UsageSchema, isAgentlessAttempt } from "./types";

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
  /** Deprecated alias of `repeatAttempts`, kept so consumers do not break (the word "wasted" was wrong: most repeats are by design). */
  wastedAttempts: z.number().int(),
  usage: UsageSchema,
  /** Deprecated alias of `repeatTokens`. */
  wastedTokens: z.number(),
  /** Repeat passes: earlier attempts of a step (not its last), or one whose agent did not finish. Equals feedback + poll + retry + interrupted. */
  repeatAttempts: z.number().int().default(0),
  /** Tokens (input + output) of the repeat passes. */
  repeatTokens: z.number().default(0),
  /** Repeat passes that ended with an outcome whose transition is a `goto` (or an `ask`): the loop worked as designed. */
  feedbackAttempts: z.number().int().default(0),
  /** Repeat passes that ended with a `goto` that has a `delay`: a re-check after a wait (a poll). */
  pollAttempts: z.number().int().default(0),
  /** Repeat passes that ended in failure or a timeout, after which the step ran again. */
  retryAttempts: z.number().int().default(0),
  /** Repeat passes whose agent did not finish (error, canceled, lost) or ended without a report. */
  interruptedAttempts: z.number().int().default(0),
  /** Passes of a stalled loop: STALLED_AFTER identical outcomes and summaries in a row (polls excepted), or a loop that hit its limit gate. Overlaps the other kinds. */
  stalledAttempts: z.number().int().default(0),
  /** Tokens of the stalled passes. */
  stalledTokens: z.number().default(0),
  /** Lost work: retries + interrupted attempts, failed or interrupted work. */
  lostAttempts: z.number().int().default(0),
  lostTokens: z.number().default(0),
  /** `lostTokens` over the row's total tokens, 0..1. */
  lostShare: z.number().default(0),
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
    /** The cumulative session cost, when the daemon reports one: the baseline of the next cost delta, kept across restarts. */
    totalCostUsd: z.number().optional(),
  }),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export const AgentRowSchema = AgentUsageSchema.omit({ last: true });
export type AgentRow = z.infer<typeof AgentRowSchema>;

/** The label of the run managers' rows (by role; by step it follows the playbook and a slash). */
export const MANAGER_LABEL = "Playbook Manager";

/** A loop is stalled once this many passes in a row return the same outcome and summary. */
export const STALLED_AFTER = 3;

/** How a repeat pass ended: a loop as designed (`feedback`), a delayed re-check (`poll`), `retry`, or `interrupted`. */
export type PassKind = "feedback" | "poll" | "retry" | "interrupted";

/** The rows to show, sorted by tokens (the default, as `analyze` returns them) or by the share of lost work, most first. */
export function sortRows<T extends { usage: Usage; lostShare?: number }>(rows: T[], by: "tokens" | "lost"): T[] {
  if (by === "tokens") return rows;
  return [...rows].sort((a, b) => (b.lostShare ?? 0) - (a.lostShare ?? 0) || tokensOf(b.usage) - tokensOf(a.usage));
}

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

/**
 * What a playbook costs in quota on one provider window, from the learned history (ADR 2026-11-24-quota-per-hour). It is the
 * cumulative history, not limited by the analytics range.
 */
export const QuotaRateSchema = z.object({
  playbook: z.string(),
  provider: z.string(),
  /** The usage window id (a quota term: weekly, session...). */
  window: z.string(),
  /** Points (percent of the window) per hour of active agent time: the sum of the finished agent attempts' time, never gate, script or waiting time between steps. Null while no agent time was measured. */
  burnRate: z.number().nullable(),
  /** Points one finished agent attempt used on average. */
  pointsPerStep: z.number(),
  /** Estimated points of one finished run: points per attempt x agent attempts per finished run in the range. Null without a finished run. */
  quotaPerRun: z.number().nullable(),
  /** Finished agent attempts the averages rest on (decayed to 200). */
  steps: z.number(),
  /** Agent time behind the rate, ms; null when none was measured. */
  agentMs: z.number().nullable(),
  /** Fewer than LOW_CONFIDENCE_STEPS finished attempts or less than LOW_CONFIDENCE_MS of agent time: only a rough figure. */
  lowConfidence: z.boolean(),
});
export type QuotaRate = z.infer<typeof QuotaRateSchema>;

/** A rate is low confidence under this many finished agent attempts or this much agent time (ms). */
export const LOW_CONFIDENCE_STEPS = 5;
export const LOW_CONFIDENCE_MS = 10 * 60_000;

/** The learned rows of the cost history, as `analyze` receives them (server/rate-budget.ts `CostHistory.rows`). */
export interface RateInput {
  playbook: string;
  provider: string;
  window: string;
  steps: number;
  pointsPerStep: number;
  agentMs: number | null;
  pointsPerHour: number | null;
}

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
  /** The quota cost of each playbook per provider window: points per active agent hour, per step and per run; absent from servers older than it. */
  quotaRates: z.array(QuotaRateSchema).default([]),
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
  repeat: number;
  repeatTokens: number;
  kinds: Record<PassKind, number>;
  stalled: number;
  stalledTokens: number;
  lostTokens: number;
  usage: Usage;
}

/** What one attempt adds to a row: its usage, and how it counts when it is a repeat pass. */
interface Pass {
  kind?: PassKind | null;
  stalled?: boolean;
  manager?: boolean;
}

class Groups {
  private readonly map = new Map<string, Group>();
  add(key: string, detail: string | null, runId: string, usage: Usage, pass: Pass = {}): void {
    const id = rowId({ key, manager: pass.manager });
    let group = this.map.get(id);
    if (!group) {
      this.map.set(id, (group = { detail, runs: new Set(), attempts: 0, repeat: 0, repeatTokens: 0, kinds: { feedback: 0, poll: 0, retry: 0, interrupted: 0 }, stalled: 0, stalledTokens: 0, lostTokens: 0, usage: zero() }));
    }
    const tokens = tokensOf(usage);
    group.runs.add(runId);
    group.attempts += 1;
    group.usage = plus(group.usage, usage);
    if (pass.kind) {
      group.repeat += 1;
      group.repeatTokens += tokens;
      group.kinds[pass.kind] += 1;
      if (pass.kind === "retry" || pass.kind === "interrupted") group.lostTokens += tokens;
    }
    if (pass.stalled) {
      group.stalled += 1;
      group.stalledTokens += tokens;
    }
  }
  rows(limit: number): UsageRow[] {
    return [...this.map.entries()]
      .map(([id, g]) => {
        const total = tokensOf(g.usage);
        return {
          key: id.startsWith("\u0000") ? id.slice(1) : id,
          manager: id.startsWith("\u0000"),
          detail: g.detail,
          runs: g.runs.size,
          attempts: g.attempts,
          wastedAttempts: g.repeat,
          usage: g.usage,
          wastedTokens: g.repeatTokens,
          repeatAttempts: g.repeat,
          repeatTokens: g.repeatTokens,
          feedbackAttempts: g.kinds.feedback,
          pollAttempts: g.kinds.poll,
          retryAttempts: g.kinds.retry,
          interruptedAttempts: g.kinds.interrupted,
          stalledAttempts: g.stalled,
          stalledTokens: g.stalledTokens,
          lostAttempts: g.kinds.retry + g.kinds.interrupted,
          lostTokens: g.lostTokens,
          lostShare: total > 0 ? g.lostTokens / total : 0,
        };
      })
      .sort((a, b) => tokensOf(b.usage) - tokensOf(a.usage))
      .slice(0, limit);
  }
}

/**
 * How each attempt of a step counts: null for one that is no repeat (the step's last attempt, when its agent finished), else why it
 * ended. A failure or timeout that the step ran again is a retry; an agent that did not finish (error, canceled, lost) or reported
 * nothing is interrupted; an outcome whose transition is a `goto` with a `delay` is a poll, any other `goto` or `ask` is feedback.
 * `stalled` flags the passes of a loop that returned STALLED_AFTER identical outcomes and summaries in a row (polls repeat by design, so
 * they never count), or that hit its limit gate. Pure.
 */
export function classifyAttempts(step: Step, attempts: Attempt[], limitReached: boolean): Array<{ kind: PassKind | null; stalled: boolean }> {
  const kinds = attempts.map((attempt, index): PassKind | null => {
    const last = index === attempts.length - 1;
    const end = attempt.turnEnd;
    if (end === "timeout") return "retry";
    if (end !== null && end !== "completed") return "interrupted";
    if (last) return null;
    if (!attempt.report) return "interrupted";
    const outcome = attempt.outcome ?? attempt.report.outcome;
    const transition = step.on?.[outcome];
    if (transition?.kind === "goto") return transition.delayMs ? "poll" : "feedback";
    if (transition?.kind === "ask") return "feedback";
    // No edge of its own, yet the step ran again. The next attempt says why it exists (`retry`): a goto from ANOTHER step (a check
    // looping back to a fix step) is a recheck or feedback, only `interrupted` is a retry. An attempt from before that field existed
    // (null): a finished attempt that did not fail was sent back by another step, so it is feedback; a `failure` was retried.
    const why = attempts[index + 1]?.retry ?? null;
    if (why === "recheck") return "poll";
    if (why === "feedback") return "feedback";
    if (why === "interrupted") return "retry";
    return outcome === "failure" ? "retry" : "feedback";
  });
  const stalled = attempts.map(() => false);
  let start = 0;
  const signature = (attempt: Attempt) => (attempt.report ? `${attempt.outcome ?? attempt.report.outcome}\u0000${attempt.report.summary.trim()}` : null);
  for (let i = 1; i <= attempts.length; i++) {
    const same = i < attempts.length && kinds[i] !== "poll" && kinds[start] !== "poll" && signature(attempts[i]!) !== null && signature(attempts[i]!) === signature(attempts[start]!);
    if (same) continue;
    if (i - start >= STALLED_AFTER) for (let j = start; j < i; j++) stalled[j] = true;
    start = i;
  }
  if (limitReached) kinds.forEach((kind, i) => { if (kind === "feedback") stalled[i] = true; });
  return kinds.map((kind, i) => ({ kind, stalled: stalled[i]! }));
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
  /** The learned quota cost history (the cumulative one, not narrowed by `since`). */
  rates?: RateInput[];
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
  const finished = new Map<string, { runs: number; attempts: number }>();
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
      byStep.add(stepKey, `role ${MANAGER_LABEL}, model ${managerModel}`, run.id, managerUsage, { manager: true });
      byRole.add(MANAGER_LABEL, null, run.id, managerUsage, { manager: true });
      byModel.add(managerModel, null, run.id, managerUsage);
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
      const limitReached = run.gates.some((gate) => gate.kind === "loop_limit" && gate.stepId === step.id);
      const passes = classifyAttempts(step, attempts, limitReached);
      attempts.forEach((attempt, index) => {
        if (isAgentlessAttempt(attempt.agentId) || !attempt.usage) return;
        any = true;
        const pass = passes[index]!;
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
        byStep.add(`${playbook}/${step.id}`, `role ${step.role ?? "none"}, model ${model}`, run.id, attempt.usage, pass);
        byRole.add(step.role ?? "(no role)", null, run.id, attempt.usage, pass);
        byModel.add(model, null, run.id, attempt.usage, pass);
      });
    }
    if (run.status === "completed") {
      const done = finished.get(playbook) ?? { runs: 0, attempts: 0 };
      done.runs += 1;
      for (const step of run.playbook.steps) done.attempts += (run.steps[step.id]?.attempts ?? []).filter((attempt) => !isAgentlessAttempt(attempt.agentId)).length;
      finished.set(playbook, done);
    }
    if (!any) withoutUsage += 1;
    byPlaybook.add(playbook, null, run.id, runUsage);
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
    quotaRates: (options.rates ?? [])
      .filter((rate) => !options.playbook || rate.playbook === options.playbook)
      .map((rate): QuotaRate => {
        const done = finished.get(rate.playbook);
        return {
          playbook: rate.playbook,
          provider: rate.provider,
          window: rate.window,
          burnRate: rate.pointsPerHour,
          pointsPerStep: rate.pointsPerStep,
          quotaPerRun: done && done.runs > 0 ? (rate.pointsPerStep * done.attempts) / done.runs : null,
          steps: rate.steps,
          agentMs: rate.agentMs,
          lowConfidence: rate.steps < LOW_CONFIDENCE_STEPS || (rate.agentMs ?? 0) < LOW_CONFIDENCE_MS,
        };
      })
      .sort((a, b) => a.playbook.localeCompare(b.playbook) || a.provider.localeCompare(b.provider) || a.window.localeCompare(b.window))
      .slice(0, limit * 4),
    daily: {
      byPlaybook: daily.byPlaybook.series(dayList, top),
      byStep: daily.byStep.series(dayList, top),
      byRole: daily.byRole.series(dayList, top),
      byModel: daily.byModel.series(dayList, top),
    },
  };
}
