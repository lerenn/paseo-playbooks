import { z } from "zod";
import type { Gate, Run } from "../shared/types";
import { isActive } from "../shared/types";
import { type BusEvent, type EventBus, type EventTypeDef } from "./bus";
import { failedListing, gateListing, type GateListing } from "./overseer";

/** The first producers of the bus: gates opening, waiting too long and being decided, and runs failing. */

export const DEFAULT_STALE_MINUTES = 30;
const SOURCE = "runs";

const runFields = { runId: z.string(), playbook: z.string(), runName: z.string().nullable(), projectId: z.string(), workspaceDir: z.string() };
const stepFields = { ...runFields, stepId: z.string(), attempt: z.number().int().nullable() };
const gateFields = {
  ...runFields,
  gateId: z.string(),
  stepId: z.string(),
  kind: z.enum(["gate", "ask", "loop_limit"]),
  question: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string(), comment: z.string() })),
  deciderBy: z.enum(["human", "manager", "role"]),
  heldBy: z.string(),
  roleDeciding: z.boolean(),
};

function runName(payload: { runId?: unknown; playbook?: unknown; runName?: unknown }): string {
  return `run ${payload.runId} (${payload.playbook}${payload.runName ? `, "${payload.runName}"` : ""})`;
}

function gateBody(event: BusEvent): string {
  const p = event.payload as unknown as GateListing & { choices: GateListing["choices"] };
  const choices = p.choices.map((choice) => `${choice.id}${choice.comment === "required" ? " (needs a comment)" : ""}`).join(" | ");
  const holder = p.roleDeciding ? `held by ${p.heldBy}, not waiting for a human yet` : `held by ${p.heldBy}`;
  const label = p.kind === "ask" ? "ask" : p.kind === "loop_limit" ? "loop-limit gate" : "gate";
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
      const label = p.kind === "ask" ? "ask" : p.kind === "loop_limit" ? "loop-limit gate" : "gate";
      return `- gate.escalated: ${before} left the ${label} at step ${p.stepId} of ${runName(p)} in ${p.workspaceDir} to a human: ${p.reason} Question: ${p.question} Choices: ${choices}. Now waiting for a human. Tools: list_gates { runId: "${event.runId}" }, get_run { runId: "${event.runId}", view: "full" }.`;
    },
  },
  {
    type: "gate.decided",
    description: "A gate was decided: who, via panel, chat, manager or role, and the comment.",
    payload: z.object({ ...runFields, gateId: z.string(), stepId: z.string(), kind: z.enum(["gate", "ask", "loop_limit"]), deciderBy: z.enum(["human", "manager", "role"]), decision: z.string(), decidedBy: z.string().nullable(), decidedVia: z.string().nullable(), comment: z.string().nullable() }),
    line: (event) => {
      const p = event.payload;
      return `- gate.decided: ${p.kind === "ask" ? "ask" : "gate"} ${p.gateId} at step ${p.stepId} of ${runName(p)} was decided: ${p.decision}, by ${p.decidedBy ?? "a human"} via ${p.decidedVia ?? "the panel"}.${p.comment ? ` Comment: "${p.comment}".` : ""} Tools: get_run { runId: "${event.runId}" }.`;
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
    type: "run.completed",
    description: "A run completed (its main steps are done; after-tasks may still run).",
    payload: z.object(runFields),
    line: (event) => `- run.completed: ${runName(event.payload)} in ${String(event.payload.workspaceDir)} completed. Tools: get_run { runId: "${event.runId}" }.`,
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

function gatePayload(listing: GateListing) {
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
    for (const run of runs) {
      if (run.archivedAt) {
        if (seeding) this.cursor.set(run.id, run.seq);
        continue;
      }
      if (seeding) this.cursor.set(run.id, run.seq);
      for (const gate of run.gates) {
        const key = `${run.id}/${gate.id}`;
        if (gate.status === "pending") {
          if (!isActive(run)) continue;
          open.add(key);
          const listing = gateListing(run, gate, now);
          if (!this.known.has(key)) {
            this.known.set(key, true);
            if (!seeding) await this.bus.emit("gate.opened", gatePayload(listing), { runId: run.id, source: SOURCE });
          }
          await this.escalation(run, gate, key, listing);
          for (const threshold of thresholds) {
            const mark = `${key}/${threshold}`;
            if (this.staleDone.has(mark) || (listing.ageMinutes ?? 0) < threshold) continue;
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
            { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, projectId: run.projectId, workspaceDir: run.workspaceDir, gateId: gate.id, stepId: gate.stepId, kind: gate.kind, deciderBy: holder.decider, decision: gate.status, decidedBy: gate.decidedBy, decidedVia: gate.decidedVia, comment: gate.comment },
            { runId: run.id, source: SOURCE, actors: actorsOf(run, gate) },
          );
        }
      }
      // After the gates: a decision is announced before the step and run it ends.
      if (!seeding) await this.lifecycle(run);
      if (run.status === "failed" && !this.failures.has(run.id)) {
        this.failures.add(run.id);
        if (seeding || run.train) continue;
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
    if (run.train) return;
    const base = { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, projectId: run.projectId, workspaceDir: run.workspaceDir };
    const meta = { runId: run.id, source: SOURCE };
    for (const entry of run.history) {
      if (entry.seq <= from) continue;
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
    const actors = by === "role" ? (gate.deciderAgentId ? [gate.deciderAgentId] : []) : [run.managerAgentId];
    await this.bus.emit(
      "gate.escalated",
      { ...gatePayload(listing), heldBefore: by, heldBeforeRole: by === "role" ? gate.decider.role ?? null : null, reason: gate.escalated, escalatedAt: gate.escalatedAt ?? null, waitingForHuman: true },
      { runId: run.id, source: SOURCE, actors },
    );
  }
}
