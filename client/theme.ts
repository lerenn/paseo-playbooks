import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { RunStatus, StepStatus } from "../shared/types";

export type Theme = PluginHostProps["theme"];

/** Visual state of a node, combining the step status with its agent's live state. */
export type NodeState = StepStatus | "definition" | "needs_permission";

export function nodeColor(theme: Theme, state: NodeState): string {
  switch (state) {
    case "completed":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
    case "waiting":
    case "needs_permission":
    case "reported":
      return theme.colors.statusWarning;
    case "running":
      return theme.colors.accent;
    case "ready":
      return theme.colors.foreground;
    default:
      return theme.colors.border;
  }
}

export function nodeIcon(state: NodeState): string {
  switch (state) {
    case "completed":
      return "Check";
    case "failed":
      return "X";
    case "running":
      return "Loader";
    case "waiting":
      return "Hourglass";
    case "reported":
      return "MessageSquare";
    case "needs_permission":
      return "ShieldAlert";
    case "ready":
      return "CirclePlay";
    default:
      return "Circle";
  }
}

export function nodeStateLabel(state: NodeState): string {
  switch (state) {
    case "needs_permission":
      return "needs permission";
    case "reported":
      return "waiting for manager";
    case "waiting":
      return "waiting for a human";
    case "definition":
      return "";
    default:
      return state;
  }
}

export function runStatusLabel(status: RunStatus): string {
  return status === "waiting_gate" ? "waiting for approval" : status;
}

export function runStatusColor(theme: Theme, status: RunStatus): string {
  switch (status) {
    case "completed":
      return theme.colors.statusSuccess;
    case "failed":
    case "canceled":
      return theme.colors.statusDanger;
    case "waiting_gate":
      return theme.colors.statusWarning;
    default:
      return theme.colors.accent;
  }
}
