import { z } from "zod";
import type { Gate, Run } from "../shared/types";
import { isActive } from "../shared/types";
import { type BusEvent, type EventBus, type EventTypeDef } from "./bus";
import { failedListing, gateListing, type GateListing } from "./overseer";

/** The first producers of the bus: gates opening, waiting too long and being decided, and runs failing. */

export const DEFAULT_STALE_MINUTES = 30;
const SOURCE = "runs";

const runFields = { runId: z.string(), playbook: z.string(), runName: z.string().nullable(), workspaceDir: z.string() };
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
];

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
  private readonly staleDone = new Set<string>();
  private seeded = false;

  constructor(private readonly bus: EventBus) {}

  async scan(runs: Run[], now: number): Promise<void> {
    if (!this.seeded) {
      for (const event of (await this.bus.recent({ types: ["gate.stale"], limit: 10_000 })).events) this.staleDone.add(`${event.payload.runId}/${event.payload.gateId}/${event.payload.thresholdMinutes}`);
    }
    const seeding = !this.seeded;
    this.seeded = true;
    const thresholds = await this.bus.thresholds("gate.stale");
    const open = new Set<string>();
    for (const run of runs) {
      if (run.archivedAt) continue;
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
          for (const threshold of thresholds) {
            const mark = `${key}/${threshold}`;
            if (this.staleDone.has(mark) || (listing.ageMinutes ?? 0) < threshold) continue;
            this.staleDone.add(mark);
            await this.bus.emit("gate.stale", { ...gatePayload(listing), ageMinutes: listing.ageMinutes ?? threshold, thresholdMinutes: threshold }, { runId: run.id, source: SOURCE });
          }
        } else if (this.known.has(key)) {
          this.known.delete(key);
          const holder = gateListing(run, gate, now);
          await this.bus.emit(
            "gate.decided",
            { runId: run.id, playbook: run.playbook.id, runName: run.name ?? null, workspaceDir: run.workspaceDir, gateId: gate.id, stepId: gate.stepId, kind: gate.kind, deciderBy: holder.decider, decision: gate.status, decidedBy: gate.decidedBy, decidedVia: gate.decidedVia, comment: gate.comment },
            { runId: run.id, source: SOURCE, actors: actorsOf(run, gate) },
          );
        }
      }
      if (run.status === "failed" && !this.failures.has(run.id)) {
        this.failures.add(run.id);
        if (seeding || run.train) continue;
        const lost = (run.failure ?? "").startsWith("manager lost");
        const { runId, playbook, runName: name, workspaceDir, failure, restartableFrom } = failedListing(run);
        await this.bus.emit(lost ? "run.manager_lost" : "run.failed", { runId, playbook, runName: name, workspaceDir, failure, restartableFrom }, { runId: run.id, source: SOURCE });
      }
    }
    for (const key of [...this.known.keys()]) if (!open.has(key)) this.known.delete(key);
  }
}
