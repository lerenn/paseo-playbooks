import { z } from "zod";
import type { Gate, Run } from "../shared/types";
import { isActive, WARDEN_RUN_CHECKS } from "../shared/types";
import { type BusEvent, type EventBus, type EventTypeDef } from "./bus";
import { formatSlowDuration } from "../shared/slow";
import { slowEntry, SlowIndex } from "./slow";
import { isDeferred } from "../shared/gates";
import { failedListing, gateListing, type GateListing } from "./overseer";

/** The first producers of the bus: gates opening, waiting too long and being decided, and runs failing. */

export const DEFAULT_STALE_MINUTES = 30;
const SOURCE = "runs";
/** How often running steps are measured for step.slow (the panel measures every 30 s too). */
const SLOW_CHECK_MS = 30_000;

const runFields = { runId: z.string(), playbook: z.string(), runName: z.string().nullable(), projectId: z.string(), workspaceDir: z.string() };
const stepFields = { ...runFields, stepId: z.string(), attempt: z.number().int().nullable() };
const gateFields = {
  ...runFields,
  gateId: z.string(),
  stepId: z.string(),
  kind: z.enum(["gate", "ask", "loop_limit", "admission", "permission", "manager_question"]),
  /** An admission gate: the held job it asks about; null on the other kinds. */
  jobId: z.string().nullable(),
  question: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string(), comment: z.string() })),
  deciderBy: z.enum(["human", "manager", "role"]),
  heldBy: z.string(),
  roleDeciding: z.boolean(),
};

export function runFieldsOf(run: Run) {
  return { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, projectId: run.projectId, workspaceDir: run.workspaceDir };
}

function runName(payload: { runId?: unknown; playbook?: unknown; runName?: unknown }): string {
  return `run ${payload.runId} (${payload.playbook}${payload.runName ? `, "${payload.runName}"` : ""})`;
}

function gateLabel(kind: string): string {
  return kind === "ask" ? "ask" : kind === "loop_limit" ? "loop-limit gate" : kind === "admission" ? "admission gate" : kind === "permission" ? "permission request" : kind === "manager_question" ? "manager question" : "gate";
}

function gateBody(event: BusEvent): string {
  const p = event.payload as unknown as GateListing & { choices: GateListing["choices"] };
  const choices = p.choices.map((choice) => `${choice.id}${choice.comment === "required" ? " (needs a comment)" : ""}`).join(" | ");
  const holder = p.roleDeciding ? `held by ${p.heldBy}, not waiting for a human yet` : `held by ${p.heldBy}`;
  const label = gateLabel(p.kind);
  return `${label} at step ${p.stepId} of ${runName(p)} in ${p.workspaceDir}: ${p.question} Choices: ${choices}. Decider: ${holder}.`;
}

export const OVERSIGHT_TYPES: EventTypeDef[] = [
  {
    type: "gate.opened",
    description: "A gate step, ask or loop-limit gate opened.",
    payload: z.object(gateFields),
    line: (event) => `- gate.opened: ${gateBody(event)} Tools: list_gates { runId: "${event.runId}" }, get_run { runId: "${event.runId}", view: "full" }.`,
  },
  {
    type: "gate.stale",
    description: "A gate is still open after olderThanMinutes (filter; default 30), once per gate and delay.",
    payload: z.object({ ...gateFields, ageMinutes: z.number(), thresholdMinutes: z.number() }),
    threshold: { default: DEFAULT_STALE_MINUTES },
    line: (event) => `- gate.stale: still open after ${event.payload.ageMinutes} min: ${gateBody(event)} Tools: list_gates { olderThanMinutes: 0 }, get_run { runId: "${event.runId}" }.`,
  },
  {
    type: "gate.escalated",
    description: "A gate held by the manager or a role decider was handed to a human: its reason, and who held it before.",
    payload: z.object({ ...gateFields, heldBefore: z.enum(["manager", "role"]), heldBeforeRole: z.string().nullable(), reason: z.string(), escalatedAt: z.string().nullable(), waitingForHuman: z.literal(true) }),
    line: (event) => {
      const p = event.payload as unknown as GateListing & { heldBefore: string; heldBeforeRole: string | null; reason: string };
      const before = p.heldBefore === "role" ? `role ${p.heldBeforeRole}` : "the manager";
      const choices = p.choices.map((choice) => `${choice.id}${choice.comment === "required" ? " (needs a comment)" : ""}`).join(" | ");
      const label = gateLabel(p.kind);
      return `- gate.escalated: ${before} left the ${label} at step ${p.stepId} of ${runName(p)} in ${p.workspaceDir} to a human: ${p.reason} Question: ${p.question} Choices: ${choices}. Now waiting for a human. Tools: list_gates { runId: "${event.runId}" }, get_run { runId: "${event.runId}", view: "full" }.`;
    },
  },
  {
    type: "gate.deferred",
    description: "A human (or the Sidekick for them) deferred an open gate to Waiting: its reason and what it waits for. The gate stays open and decidable.",
    payload: z.object({ ...runFields, gateId: z.string(), stepId: z.string(), kind: z.enum(["gate", "ask", "loop_limit", "admission", "permission", "manager_question"]), reason: z.string(), waitsFor: z.string(), tracked: z.boolean(), deferredBy: z.string() }),
    line: (event) => `- gate.deferred: ${gateLabel(String(event.payload.kind))} ${event.payload.gateId} at step ${event.payload.stepId} of ${runName(event.payload)} was deferred by ${event.payload.deferredBy}: ${event.payload.reason} ${event.payload.waitsFor}. Still open; not in Needs you until it returns.`,
  },
  {
    type: "gate.returned",
    description: "A deferred gate is back in Needs you (a human or the Sidekick brought it back, or its tracked condition or reminder date came): returnedBy (human, agent, date, reminder, run_ended, gate_decided) and why.",
    payload: z.object({ ...gateFields, reason: z.string(), returnedBy: z.string(), returnNote: z.string().nullable(), automatic: z.boolean() }),
    line: (event) => `- gate.returned: ${gateBody(event)} It is back to review (${event.payload.returnedBy}${event.payload.returnNote ? `: ${event.payload.returnNote}` : ""}); it was deferred because: ${event.payload.reason}. Tools: list_gates { runId: "${event.runId}" }, get_run { runId: "${event.runId}", view: "full" }.`,
  },
  {
    type: "gate.decided",
    description: "A gate was decided: who, via panel, chat, manager or role, and the comment.",
    payload: z.object({ ...runFields, gateId: z.string(), stepId: z.string(), kind: z.enum(["gate", "ask", "loop_limit", "admission", "permission", "manager_question"]), jobId: z.string().nullable(), deciderBy: z.enum(["human", "manager", "role"]), decision: z.string(), decidedBy: z.string().nullable(), decidedVia: z.string().nullable(), comment: z.string().nullable() }),
    line: (event) => {
      const p = event.payload;
      if (p.decision === "dismissed") return `- gate.decided: ${gateLabel(String(p.kind))} ${p.gateId} of ${runName(p)} was closed without a decision${p.comment ? ` (${p.comment})` : ""}. Tools: get_run { runId: "${event.runId}" }.`;
      return `- gate.decided: ${gateLabel(String(p.kind))} ${p.gateId} at step ${p.stepId} of ${runName(p)} was decided: ${p.decision}, by ${p.decidedBy ?? "a human"} via ${p.decidedVia ?? "the panel"}.${p.comment ? ` Comment: "${p.comment}".` : ""} Tools: get_run { runId: "${event.runId}" }.`;
    },
  },
  {
    type: "run.failed",
    description: "A run failed (not for a lost manager: see run.manager_lost): reason and the steps it can restart from.",
    payload: z.object({ ...runFields, failure: z.string().nullable(), restartableFrom: z.array(z.string()) }),
    line: (event) => failedLine(event, "run.failed"),
  },
  {
    type: "run.manager_lost",
    description: "A run failed because its manager was archived or is gone.",
    payload: z.object({ ...runFields, failure: z.string().nullable(), restartableFrom: z.array(z.string()) }),
    line: (event) => failedLine(event, "run.manager_lost"),
  },
  {
    type: "run.held",
    description: "Rate limiting holds a run's new steps (not enough quota headroom for its estimated cost, a provider at its usable share, or a step or playbook cap): kind, reason, provider, window, estimated cost, headroom, queue position, priority and when it is looked at again. Running steps finish; the plugin resumes the run by itself.",
    payload: z.object({ ...runFields, kind: z.enum(["steps", "playbooks", "quota", "headroom", "pace"]), reason: z.string(), provider: z.string().nullable(), window: z.string().nullable(), retryAt: z.string().nullable(), estimatedCost: z.number().nullable().default(null), headroom: z.number().nullable().default(null), position: z.number().nullable().default(null), priority: z.number().nullable().default(null) }),
    line: (event) => `- run.held: ${runName(event.payload)} is on hold (${event.payload.kind}): ${event.payload.reason}.${event.payload.retryAt ? ` Looked at again at ${event.payload.retryAt}.` : ""} The plugin resumes it by itself: nothing to do. Tools: get_run { runId: "${event.runId}" }.`,
  },
  {
    type: "run.released",
    description: "A rate limit hold on a run ended (capacity or quota returned): the plugin starts its ready steps by itself.",
    payload: z.object({ ...runFields }),
    line: (event) => `- run.released: ${runName(event.payload)} is no longer on hold; its steps continue. Tools: get_run { runId: "${event.runId}" }.`,
  },
  {
    type: "step.started",
    description: "A step attempt started (agent and script steps; each attempt of a retried or looped step again): stepId and attempt number.",
    payload: z.object(stepFields),
    line: (event) => stepLine(event, "started"),
  },
  {
    type: "step.completed",
    description: "A step ended an attempt with an outcome, failure outcomes and retried ones included (a branch step: its case): stepId, attempt (null for a branch step) and outcome.",
    payload: z.object({ ...stepFields, outcome: z.string() }),
    line: (event) => stepLine(event, `ended with outcome ${String(event.payload.outcome)}`),
  },
  {
    type: "step.slow",
    description: "A running step first went past `factor` times its usual duration (the panel's attention triangle; shared/slow.ts): stepId, elapsedMs, baselineMs, factor, ratio, samples. Once per step run.",
    payload: z.object({ ...stepFields, elapsedMs: z.number(), baselineMs: z.number(), factor: z.number(), ratio: z.number(), samples: z.number().int() }),
    line: (event) => {
      const p = event.payload as { stepId: string; elapsedMs: number; baselineMs: number; ratio: number };
      return `- step.slow: step ${p.stepId} of ${runName(event.payload)} has run ${formatSlowDuration(p.elapsedMs)}, ${p.ratio}x the usual ${formatSlowDuration(p.baselineMs)}. It may be stuck. Tools: get_run { runId: "${event.runId}" }, read_agent_conversation.`;
    },
  },
  {
    type: "step.waiting_manager_stuck",
    description: "A reported step still waits for its manager after the plugin prompted it twice (the manager was idle, with no open question or human gate): stepId, attempt, outcome, summary, waitingMs, nudges. Once per stuck episode (a new report re-arms it).",
    payload: z.object({ ...stepFields, outcome: z.string(), summary: z.string(), waitingMs: z.number(), nudges: z.number().int(), managerAgentId: z.string() }),
    line: (event) => {
      const p = event.payload as { stepId: string; outcome: string; waitingMs: number; nudges: number; managerAgentId: string };
      return `- step.waiting_manager_stuck: step ${p.stepId} of ${runName(event.payload)} reported ${p.outcome} ${Math.round(p.waitingMs / 60_000)} min ago and its manager (agent ${p.managerAgentId}) did not act after ${p.nudges} prompts. Tools: get_run { runId: "${event.runId}" }, read_agent_conversation { agentId: "${p.managerAgentId}" }.`;
    },
  },
  {
    type: "manager.question_pending",
    description: "A run's manager has had a question or permission request open for the nudge delay (manager.nudge.after): the question, once per episode (answering it re-arms it).",
    payload: z.object({ ...runFields, managerAgentId: z.string(), pendingMs: z.number(), question: z.string() }),
    line: (event) => {
      const p = event.payload as { managerAgentId: string; pendingMs: number; question: string };
      return `- manager.question_pending: the manager (agent ${p.managerAgentId}) of ${runName(event.payload)} has waited ${Math.round(p.pendingMs / 60_000)} min for an answer to: ${p.question} Tools: list_pending_permissions { agentId: "${p.managerAgentId}" }, read_agent_conversation { agentId: "${p.managerAgentId}" }.`;
    },
  },
  {
    type: "warden.finding",
    description: "The warden (warden.enabled) found something that may need action, once per finding (until it clears or changes; again after warden.cooldown, and only when its count doubled or the run's state changed): check (stale_definition, manager_blocked, loops or stalled; slow and gate_open findings reuse step.slow and gate.stale), subject (the gate or edge; null for the run), detail, since.",
    payload: z.object({ ...runFields, check: z.enum(WARDEN_RUN_CHECKS), subject: z.string().nullable(), detail: z.string(), since: z.string() }),
    line: (event) => `- warden.finding: ${runName(event.payload)} in ${String(event.payload.workspaceDir)}, ${String(event.payload.check)}: ${String(event.payload.detail)}. Tools: get_run { runId: "${event.runId}" }.`,
  },
  {
    type: "run.completed",
    description: "A run completed (its main steps are done; after-tasks may still run).",
    payload: z.object(runFields),
    line: (event) => `- run.completed: ${runName(event.payload)} in ${String(event.payload.workspaceDir)} completed. Tools: get_run { runId: "${event.runId}" }.`,
  },
  {
    type: "run.definition_fallback",
    description: "A run's playbook definition was read from the workspace checkout, which may be behind origin, because origin/<branch> could not supply it (its playbook is invalid, missing or unfetchable): at the run's start, or when refresh_scripts re-read it. warning is the short reason; source is where the definition came from now.",
    payload: z.object({ ...runFields, warning: z.string(), source: z.enum(["workspace"]), trigger: z.enum(["start", "refresh_scripts"]) }),
    line: (event) => `- run.definition_fallback: ${runName(event.payload)} in ${String(event.payload.workspaceDir)}: ${String(event.payload.warning)}. It may run an out-of-date definition. Tools: get_run { runId: "${event.runId}" }, validate_playbooks.`,
  },
  {
    type: "run.auto_archived",
    description: "The plugin archived a finished run (auto_archive.enabled) after the grace period: the run and its idle manager agent; workspaceArchived says whether the workspace went too (workspaceReason when not). restart_run still reopens it.",
    payload: z.object({ ...runFields, managerArchived: z.boolean(), workspaceArchived: z.boolean(), workspaceReason: z.string().nullable() }),
    line: (event) => `- run.auto_archived: ${runName(event.payload)} in ${String(event.payload.workspaceDir)} was archived after it ended${event.payload.managerArchived ? ", with its manager" : ""}${event.payload.workspaceReason ? `; workspace kept: ${String(event.payload.workspaceReason)}` : ""}. Tools: restart_run, list_runs { archived: true }.`,
  },
  {
    type: "run.canceled",
    description: 'A run was canceled (status "canceled"): the reason, when given.',
    payload: z.object({ ...runFields, reason: z.string().nullable() }),
    line: (event) => `- run.canceled: ${runName(event.payload)} in ${String(event.payload.workspaceDir)} was canceled${event.payload.reason ? `: ${String(event.payload.reason)}` : ""}. Tools: get_run { runId: "${event.runId}" }.`,
  },
];

function stepLine(event: BusEvent, what: string): string {
  const p = event.payload as { stepId: string; attempt: number | null };
  return `- ${event.type}: step ${p.stepId}${p.attempt ? ` (attempt ${p.attempt})` : ""} of ${runName(event.payload)} ${what}. Tools: get_run { runId: "${event.runId}" }.`;
}

function failedLine(event: BusEvent, label: string): string {
  const p = event.payload as { failure: string | null; restartableFrom: string[]; workspaceDir: string };
  return `- ${label}: ${runName(event.payload)} in ${p.workspaceDir} failed${p.failure ? `: ${p.failure}` : ""}; restartable from: ${p.restartableFrom.join(", ") || "nowhere"}. Tools: get_run { runId: "${event.runId}" }, list_runs { all: true }.`;
}

export function gatePayload(listing: GateListing) {
  return { ...listing, deciderBy: listing.decider };
}

export function registerOversightTypes(bus: EventBus): void {
  for (const def of OVERSIGHT_TYPES) bus.register(def);
}

/** Agents whose own call decided the gate: the run's manager (manager or chat) and a role decider agent. */
function actorsOf(run: Run, gate: Gate): string[] {
  const actors: string[] = [];
  if (gate.decidedVia === "role" && gate.deciderAgentId) actors.push(gate.deciderAgentId);
  if (run.managerAgentId && (gate.decidedVia === "manager" || gate.decidedVia === "chat")) actors.push(run.managerAgentId);
  return actors;
}

/**
 * Turns changes of the runs into bus events. Gates open when it first looks (a daemon restart)
 * are not emitted as opened again; a gate stale delay already in the log is not emitted twice.
 */
export class OversightProducer {
  private readonly known = new Map<string, true>();
  private readonly failures = new Set<string>();
  private readonly escalatedSeen = new Set<string>();
  private readonly staleDone = new Set<string>();
  /** Per run, the last history entry looked at: step and run events come from the entries after it. */
  private readonly cursor = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly reported = new Set<string>();
  private seeded = false;
  /** Step runs already announced as slow (run, step, first start), and when the last look was. */
  private readonly slowDone = new Set<string>();
  private slowAt = 0;

  constructor(private readonly bus: EventBus) {}

  async scan(runs: Run[], now: number): Promise<void> {
    if (!this.seeded) {
      for (const event of (await this.bus.recent({ types: ["gate.stale"], limit: 10_000 })).events) this.staleDone.add(`${event.payload.runId}/${event.payload.gateId}/${event.payload.thresholdMinutes}`);
      for (const event of (await this.bus.recent({ types: ["gate.escalated"], limit: 10_000 })).events) this.escalatedSeen.add(`${event.payload.runId}/${event.payload.gateId}`);
    }
    const seeding = !this.seeded;
    this.seeded = true;
    const thresholds = await this.bus.thresholds("gate.stale");
    const open = new Set<string>();
    await this.slow(runs, now, seeding);
    for (const run of runs) {
      if (run.archivedAt) {
        if (seeding) this.cursor.set(run.id, run.seq);
        continue;
      }
      if (seeding) this.cursor.set(run.id, run.seq);
      for (const [index, gate] of run.gates.entries()) {
        // A run from before gate ids were unique may hold several gates with one id (a restarted loop-limit gate): one key, so
        // only the latest is followed; the earlier ones, decided long ago, would otherwise re-announce the new gate on every scan.
        if (run.gates.some((later, at) => at > index && later.id === gate.id)) continue;
        const key = `${run.id}/${gate.id}`;
        if (gate.status === "pending") {
          if (!isActive(run)) continue;
          open.add(key);
          const deferred = isDeferred(gate);
          const listing = gateListing(run, gate, now);
          if (!this.known.has(key)) {
            this.known.set(key, true);
            if (!seeding) await this.bus.emit("gate.opened", gatePayload(listing), { runId: run.id, source: SOURCE });
          }
          await this.escalation(run, gate, key, listing);
          for (const threshold of thresholds) {
            const mark = `${key}/${threshold}`;
            if (deferred || this.staleDone.has(mark) || (listing.ageMinutes ?? 0) < threshold) continue;
            this.staleDone.add(mark);
            await this.bus.emit("gate.stale", { ...gatePayload(listing), ageMinutes: listing.ageMinutes ?? threshold, thresholdMinutes: threshold }, { runId: run.id, source: SOURCE });
          }
        } else if (this.known.has(key)) {
          this.known.delete(key);
          await this.escalation(run, gate, key, gateListing(run, gate, now));
          this.escalatedSeen.delete(key);
          const holder = gateListing(run, gate, now);
          await this.bus.emit(
            "gate.decided",
            { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, projectId: run.projectId, workspaceDir: run.workspaceDir, gateId: gate.id, stepId: gate.stepId, kind: gate.kind, jobId: gate.jobId, deciderBy: holder.decider, decision: gate.status, decidedBy: gate.decidedBy, decidedVia: gate.decidedVia, comment: gate.comment },
            { runId: run.id, source: SOURCE, actors: actorsOf(run, gate) },
          );
        }
      }
      // After the gates: a decision is announced before the step and run it ends.
      if (!seeding) await this.lifecycle(run);
      if (run.status === "failed" && !this.failures.has(run.id)) {
        this.failures.add(run.id);
        if (seeding || run.batch) continue;
        const lost = (run.failure ?? "").startsWith("manager lost");
        const { runId, playbook, runName: name, projectId, workspaceDir, failure, restartableFrom } = failedListing(run);
        await this.bus.emit(lost ? "run.manager_lost" : "run.failed", { runId, playbook, runName: name, projectId, workspaceDir, failure, restartableFrom }, { runId: run.id, source: SOURCE });
      }
    }
    for (const key of [...this.known.keys()]) if (!open.has(key)) this.known.delete(key);
    for (const key of [...this.escalatedSeen]) if (!open.has(key) && !this.known.has(key)) this.escalatedSeen.delete(key);
  }

  /**
   * Step and run events, from the history entries written since the last look: a daemon restart
   * starts at the end of each run's history, so past transitions are not announced again.
   * step.completed follows `step_outcome`; a `step_completed` with none before it (a branch step) is one too.
   */
  private async lifecycle(run: Run): Promise<void> {
    const from = this.cursor.get(run.id) ?? 0;
    this.cursor.set(run.id, run.seq);
    // Nothing was written since the last look (every finished run, on every tick): no walk of its history.
    if (run.batch || run.seq === from) return;
    const base = { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, projectId: run.projectId, workspaceDir: run.workspaceDir };
    const meta = { runId: run.id, source: SOURCE };
    // The history is in seq order: start at the first entry past the cursor, found from the end.
    let first = run.history.length;
    while (first > 0 && run.history[first - 1]!.seq > from) first--;
    for (const entry of run.history.slice(first)) {
      const key = `${run.id}/${entry.stepId}`;
      if (entry.type === "step_started" && entry.stepId) {
        const attempt = Number(/^attempt (\d+)/.exec(entry.detail)?.[1] ?? run.steps[entry.stepId]?.attempts.at(-1)?.n ?? 0) || null;
        this.attempts.set(key, attempt ?? 0);
        this.reported.delete(key);
        await this.bus.emit("step.started", { ...base, stepId: entry.stepId, attempt }, meta);
      } else if ((entry.type === "step_outcome" || entry.type === "step_completed") && entry.stepId) {
        if (entry.type === "step_completed" && this.reported.delete(key)) continue;
        const branch = entry.type === "step_completed" && entry.detail.startsWith("branch ");
        if (entry.type === "step_outcome") this.reported.add(key);
        const outcome = branch ? (run.steps[entry.stepId]?.branch ?? entry.detail) : entry.type === "step_outcome" ? entry.detail.split(" (")[0]! : entry.detail;
        const attempt = branch ? null : (this.attempts.get(key) ?? run.steps[entry.stepId]?.attempts.at(-1)?.n ?? null) || null;
        await this.bus.emit("step.completed", { ...base, stepId: entry.stepId, attempt, outcome }, meta);
      } else if (entry.type === "run_held") {
        const hold = run.rateHold;
        await this.bus.emit("run.held", { ...base, kind: hold?.kind ?? "quota", reason: entry.detail, provider: hold?.provider ?? null, window: hold?.window ?? null, retryAt: hold?.retryAt ?? null, estimatedCost: hold?.estimatedCost ?? null, headroom: hold?.headroom ?? null, position: hold?.position ?? null, priority: hold?.priority ?? null }, meta);
      } else if (entry.type === "run_released") {
        await this.bus.emit("run.released", base, meta);
      } else if (entry.type === "run_completed") {
        await this.bus.emit("run.completed", base, meta);
      } else if (entry.type === "run_canceled") {
        await this.bus.emit("run.canceled", { ...base, reason: entry.detail || null }, meta);
      }
    }
  }

  /** Emits gate.escalated once per gate (remembered through the log across restarts): when a manager or role decider handed it to a human, a restart that lost the decider included. */
  private async escalation(run: Run, gate: Gate, key: string, listing: GateListing): Promise<void> {
    if (gate.escalated === null || this.escalatedSeen.has(key)) return;
    this.escalatedSeen.add(key);
    // Gates escalated before this version recorded when: not announced now.
    if (gate.escalatedAt === null) return;
    const by = gate.decider.by === "role" ? "role" : "manager";
    const actors = by === "role" ? (gate.deciderAgentId ? [gate.deciderAgentId] : []) : [run.managerAgentId].filter(Boolean);
    await this.bus.emit(
      "gate.escalated",
      { ...gatePayload(listing), heldBefore: by, heldBeforeRole: by === "role" ? gate.decider.role ?? null : null, reason: gate.escalated, escalatedAt: gate.escalatedAt ?? null, waitingForHuman: true },
      { runId: run.id, source: SOURCE, actors },
    );
  }

  /** step.slow: at most every SLOW_CHECK_MS, and only while a step runs; a daemon restart does not announce the ones already slow. */
  private async slow(runs: Run[], now: number, seeding: boolean): Promise<void> {
    if (!seeding && now - this.slowAt < SLOW_CHECK_MS) return;
    const running = runs.filter((run) => !run.archivedAt && !run.batch && isActive(run) && Object.values(run.steps).some((state) => state.status === "running"));
    if (running.length === 0) return;
    this.slowAt = now;
    const index = new SlowIndex(runs);
    for (const run of running) {
      for (const [stepId, info] of Object.entries(index.of(run, now))) {
        const state = run.steps[stepId]!;
        if (state.status !== "running") continue;
        const key = `${run.id}/${stepId}/${state.attempts[0]?.startedAt ?? ""}`;
        if (this.slowDone.has(key)) continue;
        this.slowDone.add(key);
        if (seeding) continue;
        const { factor, ratio, samples } = slowEntry(run, stepId, info);
        await this.bus.emit(
          "step.slow",
          { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, projectId: run.projectId, workspaceDir: run.workspaceDir, stepId, attempt: state.attempts.at(-1)?.n ?? null, elapsedMs: info.elapsedMs, baselineMs: Math.round(info.baselineMs), factor, ratio, samples },
          { runId: run.id, source: SOURCE },
        );
      }
    }
  }
}
