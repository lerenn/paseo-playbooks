import { choicesOfGate, gateText, waitsForHuman } from "../shared/gates";
import type { Gate, Run } from "../shared/types";
import { isActive, restartBlocker } from "../shared/types";
import { stepDef } from "./engine";

/** Who holds an open gate: a human, the run's manager, or a role still deciding. A gate a role or manager escalated is a human's. */
export function gateHolder(gate: Gate): { by: "human" | "manager" | "role"; role: string | null; heldBy: string; roleDeciding: boolean } {
  const decider = gate.decider ?? { by: "human" as const };
  const roleDeciding = decider.by === "role" && gate.escalated === null;
  const role = decider.by === "role" ? decider.role ?? null : null;
  const heldBy = roleDeciding ? `role ${role}` : decider.by === "manager" && gate.escalated === null ? "manager (or a human, if it asks)" : "human";
  return { by: decider.by, role, heldBy, roleDeciding };
}

/**
 * One open gate or ask of a run. Compact and stable (same fields, same order, oldest first),
 * so a scheduled agent can call list_gates and diff. No run inputs, reports or outputs.
 */
export function gateListing(run: Run, gate: Gate, now: number) {
  const holder = gateHolder(gate);
  const text = gateText(gate);
  const opened = Date.parse(gate.requestedAt);
  const known = run.playbook.steps.some((step) => step.id === gate.stepId) || run.playbook.after.some((task) => task.id === gate.stepId);
  return {
    runId: run.id,
    playbook: run.playbook.id,
    runName: run.name ?? null,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    workspaceDir: run.workspaceDir,
    managerAgentId: run.managerAgentId,
    gateId: gate.id,
    stepId: gate.stepId,
    kind: gate.kind,
    jobId: gate.jobId,
    question: text.summary,
    choices: choicesOfGate(gate, known ? stepDef(run, gate.stepId) : undefined).map((choice) => ({ id: choice.id, label: choice.label, comment: choice.comment })),
    decider: holder.by,
    deciderRole: holder.role,
    heldBy: holder.heldBy,
    roleDeciding: holder.roleDeciding,
    waitingForHuman: waitsForHuman(gate),
    escalatedAt: gate.escalated !== null ? gate.escalatedAt ?? null : null,
    escalationReason: gate.escalated,
    openedAt: gate.requestedAt,
    ageMinutes: Number.isNaN(opened) ? null : Math.max(0, Math.floor((now - opened) / 60_000)),
  };
}
export type GateListing = ReturnType<typeof gateListing>;

/** A run that failed or lost its manager: why, and the steps restart_run accepts. */
export function failedListing(run: Run) {
  return {
    runId: run.id,
    playbook: run.playbook.id,
    runName: run.name ?? null,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    workspaceDir: run.workspaceDir,
    managerAgentId: run.managerAgentId,
    failure: run.failure,
    managerLost: (run.failure ?? "").startsWith("manager lost"),
    restartableFrom: run.playbook.steps.filter((step) => restartBlocker(run, step.id) === null).map((step) => step.id),
  };
}

export interface GateFilter {
  runId?: string | undefined;
  olderThanMinutes?: number | undefined;
  includeFinished?: boolean | undefined;
  includeFailed?: boolean | undefined;
}

/** Open gates and asks of the (non-archived, active) runs, oldest first, and optionally the failed runs. */
export function listAttention(runs: Run[], now: number, filter: GateFilter = {}) {
  const visible = runs.filter((run) => !run.archivedAt && (!filter.runId || run.id === filter.runId));
  const gates = visible
    .filter((run) => filter.includeFinished || isActive(run))
    .flatMap((run) => run.gates.filter((gate) => gate.status === "pending").map((gate) => gateListing(run, gate, now)))
    .filter((gate) => filter.olderThanMinutes === undefined || (gate.ageMinutes ?? 0) >= filter.olderThanMinutes)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.runId.localeCompare(b.runId) || a.gateId.localeCompare(b.gateId));
  const failed = filter.includeFailed ? visible.filter((run) => run.status === "failed" && !run.batch).map(failedListing).sort((a, b) => a.runId.localeCompare(b.runId)) : [];
  return { gates, failed };
}

/** One line per gate (and failed run) for the tool's text; the structured content has the rest. */
export function attentionText(result: ReturnType<typeof listAttention>): string {
  if (result.gates.length === 0 && result.failed.length === 0) return "No open gate or ask.";
  const gates = result.gates.map((gate) => {
    const choices = gate.choices.map((choice) => choice.id).join("|");
    return `- ${gate.runId} (${gate.playbook}${gate.runName ? `, ${gate.runName}` : ""}) step ${gate.stepId} ${gate.kind} ${gate.gateId}, ${gate.ageMinutes ?? "?"} min, held by ${gate.heldBy}: ${gate.question} [${choices}]`;
  });
  const failed = result.failed.map((run) => `- FAILED ${run.runId} (${run.playbook}${run.runName ? `, ${run.runName}` : ""}): ${run.failure ?? "no reason"}; restartable from: ${run.restartableFrom.join(", ") || "nowhere"}`);
  return [...gates, ...failed].join("\n");
}

