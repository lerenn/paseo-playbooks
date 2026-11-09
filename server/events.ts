import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Gate, Run } from "../shared/types";
import { failedListing, gateListing, type GateListing } from "./overseer";

/** What an agent can subscribe to. manager_lost is not also a run_failed. */
export const EVENT_NAMES = ["gate_opened", "gate_stale", "gate_decided", "run_failed", "manager_lost"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** Minutes a gate stays open before gate_stale fires, unless the subscription's filter says otherwise. */
export const DEFAULT_STALE_MINUTES = 30;
/** Most subscriptions one agent may hold. */
export const MAX_SUBSCRIPTIONS = 20;

export const SubscriptionFilterSchema = z.object({
  playbook: z.string().optional(),
  runId: z.string().optional(),
  deciderBy: z.enum(["human", "manager", "role"]).optional(),
  olderThanMinutes: z.number().min(0).optional(),
});
export type SubscriptionFilter = z.infer<typeof SubscriptionFilterSchema>;

export const SubscriptionSchema = z.object({
  id: z.string(),
  /** The subscriber: the agent that called subscribe_events, and the one messaged. */
  agentId: z.string(),
  events: z.array(z.enum(EVENT_NAMES)).min(1),
  filter: SubscriptionFilterSchema.default({}),
  createdAt: z.string(),
  /** Gates already reminded (gate_stale), "<run>/<gate>": one reminder per gate, kept across restarts. */
  reminded: z.array(z.string()).default([]),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export async function loadSubscriptions(file: string): Promise<Subscription[]> {
  try {
    return z.array(SubscriptionSchema).parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return [];
  }
}

export async function saveSubscriptions(file: string, subscriptions: Subscription[]): Promise<void> {
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(subscriptions, null, 2)}\n`);
  await rename(temp, file);
}

/** Whether a run (and its gate, for a gate event) passes the subscription's filter. */
export function matches(filter: SubscriptionFilter, run: Run, gate?: Gate): boolean {
  if (filter.playbook && run.playbook.id !== filter.playbook) return false;
  if (filter.runId && run.id !== filter.runId) return false;
  if (filter.deciderBy && gate && (gate.decider?.by ?? "human") !== filter.deciderBy) return false;
  return true;
}

/**
 * A gate the subscriber decided itself is not reported back to it: the run's manager that
 * resumed it (manager or chat), or the role decider agent that decided it. Nothing else is
 * skipped, so a subscriber that is not a decider hears every decision.
 */
export function decidedBySubscriber(run: Run, gate: Gate, agentId: string): boolean {
  if (gate.deciderAgentId === agentId && gate.decidedVia === "role") return true;
  return run.managerAgentId === agentId && (gate.decidedVia === "manager" || gate.decidedVia === "chat");
}

function runName(run: { id: string; playbook: { id: string }; name: string | null }): string {
  return `run ${run.id} (${run.playbook.id}${run.name ? `, "${run.name}"` : ""})`;
}

function gateBody(gate: GateListing): string {
  const choices = gate.choices.map((choice) => `${choice.id}${choice.comment === "required" ? " (needs a comment)" : ""}`).join(" | ");
  const holder = gate.roleDeciding ? `held by ${gate.heldBy}, not waiting for a human yet` : `held by ${gate.heldBy}`;
  const label = gate.kind === "ask" ? "ask" : gate.kind === "loop_limit" ? "loop-limit gate" : "gate";
  return `${label} at step ${gate.stepId} of ${runName({ id: gate.runId, playbook: { id: gate.playbook }, name: gate.runName })} in ${gate.workspaceDir}: ${gate.question} Choices: ${choices}. Decider: ${holder}.`;
}

export function openedLine(gate: GateListing): string {
  return `- gate_opened: ${gateBody(gate)} Tools: list_gates { runId: "${gate.runId}" }, get_run { runId: "${gate.runId}", view: "full" }.`;
}

export function staleLine(gate: GateListing): string {
  return `- gate_stale: still open after ${gate.ageMinutes ?? "?"} min: ${gateBody(gate)} Tools: list_gates { olderThanMinutes: 0 }, get_run { runId: "${gate.runId}" }.`;
}

export function decidedLine(run: Run, gate: Gate): string {
  const comment = gate.comment ? ` Comment: "${gate.comment}".` : "";
  return `- gate_decided: ${gate.kind === "ask" ? "ask" : "gate"} ${gate.id} at step ${gate.stepId} of ${runName(run)} was decided: ${gate.status}, by ${gate.decidedBy ?? "a human"} via ${gate.decidedVia ?? "the panel"}.${comment} Tools: get_run { runId: "${run.id}" }.`;
}

export function failedLine(run: Run, lost: boolean): string {
  const listing = failedListing(run);
  const restart = `restartable from: ${listing.restartableFrom.join(", ") || "nowhere"}`;
  return `- ${lost ? "manager_lost" : "run_failed"}: ${runName(run)} in ${run.workspaceDir} failed${run.failure ? `: ${run.failure}` : ""}; ${restart}. Tools: get_run { runId: "${run.id}" }, list_runs { all: true }.`;
}

/** The message sent to a subscriber: its events of one debounce window, with the reminder that it only reads. */
export function eventsMessage(lines: string[]): string {
  return [
    `[playbooks] ${lines.length} event${lines.length === 1 ? "" : "s"} you subscribed to:`,
    ...lines,
    "",
    "list_gates shows every open gate and ask, get_run reads any run; both are read-only. A gate is decided by its run's manager or by a human in the Playbooks panel. unsubscribe_events stops these messages.",
  ].join("\n");
}
