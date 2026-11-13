export type LaneTone = "running" | "waiting" | "paused" | "done" | "seen" | "failed";

export type LaneChildStatus = "pending" | "starting" | "running" | "completed" | "failed" | "canceled" | "not_started";

/**
 * The tone of a fan-out child's icon, or null for the hollow circle (not started yet).
 * The fan-out's own record of the child wins once it is final: an archived or unknown child run
 * must never turn a completed child hollow. The live run only refines a child still in flight.
 */
export function laneTone(status: LaneChildStatus, runTone: LaneTone | null): LaneTone | null {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
    case "canceled":
    case "not_started":
      return "failed";
    case "running":
    case "starting":
      return runTone ?? "running";
    case "pending":
      return runTone;
  }
}
