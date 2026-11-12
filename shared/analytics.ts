import { z } from "zod";
import { type Run, type Usage, UsageSchema, isAgentlessAttempt } from "./types";

/** One row of a breakdown: what a group of agents spent, and how much of it was thrown away. */
export const UsageRowSchema = z.object({
  key: z.string(),
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
  add(key: string, detail: string | null, runId: string, usage: Usage, wasted: boolean): void {
    let group = this.map.get(key);
    if (!group) this.map.set(key, (group = { detail, runs: new Set(), attempts: 0, wasted: 0, usage: zero(), wastedTokens: 0 }));
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
      .map(([key, g]) => ({ key, detail: g.detail, runs: g.runs.size, attempts: g.attempts, wastedAttempts: g.wasted, usage: g.usage, wastedTokens: g.wastedTokens }))
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
}

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

  for (const run of picked) {
    let any = false;
    const playbook = run.playbook.id;
    const managerUsage = run.usageDeltas ? run.managerUsage : null;
    if (!run.usageDeltas && run.managerUsage) invalidManager += 1;
    manager = plus(manager, managerUsage);
    total = plus(total, managerUsage);
    if (managerUsage) any = true;
    for (const gate of run.gates) {
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
  };
}
