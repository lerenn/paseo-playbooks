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

/** Adds an alpha channel to a #rgb or #rrggbb theme colour; null for any other format. */
export function withAlpha(color: string, alpha: number): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return `#${full}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** Agent steps: the theme's raised surface, distinct from the card (surface1). */
export function agentBackground(theme: Theme): string {
  return theme.colors.surface2;
}

/** Human gates: a light tint of the theme's warning colour, or surface0 if it cannot be tinted. */
export function gateBackground(theme: Theme): string {
  return withAlpha(theme.colors.statusWarning, 0.14) ?? theme.colors.surface0;
}

/** Display form of a step id: first letter capitalised ("review" → "Review"). The id itself is unchanged. */
export function stepLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
