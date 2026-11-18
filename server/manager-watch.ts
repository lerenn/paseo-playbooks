import type { Gate, ManagerNudge, Run } from "../shared/types";
import { gateHolder } from "./overseer";

/**
 * The manager watchdog's rules (the runtime applies them once per event scan, no timer of its own).
 *
 * A reported step waits for its manager: when `afterMs` passed since the report and the manager is free to act, the plugin
 * prompts it; the next prompt comes after twice as long, then four times, ..., capped at `maxIntervalMs`.
 */

/** How often the watchdog looks at the runs (the manager's state costs one API read each). */
export const MANAGER_WATCH_CHECK_MS = 30_000;
/** Prompts without progress after which `step.waiting_manager_stuck` is emitted. */
export const STUCK_AFTER_NUDGES = 2;

/** The wait before prompt number `sent + 1` (0-based `sent` = prompts so far): after, 2x, 4x, ..., capped. */
export function nudgeInterval(policy: ManagerNudge, sent: number): number {
  return Math.min(policy.afterMs * 2 ** Math.min(sent, 30), policy.maxIntervalMs);
}

/** Whether the next prompt is due: `since` is the report (no prompt yet) or the last prompt. */
export function nudgeDue(policy: ManagerNudge, sent: number, since: number, now: number): boolean {
  return now >= since + nudgeInterval(policy, sent);
}

/**
 * Whether an open gate of the run is held by someone other than the manager: a human (an escalated gate included) or a role
 * decider. The manager is then waiting on them, and a prompt cannot help.
 */
export function blockedOnGate(run: Run): Gate | null {
  return run.gates.find((gate) => gate.status === "pending" && (gateHolder(gate).by !== "manager" || gate.escalated !== null)) ?? null;
}
