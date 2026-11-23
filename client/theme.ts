import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { RunStatus, StepStatus } from "../shared/types";
import { semanticColor, type SemanticTone } from "./semantic-colors";

export type Theme = PluginHostProps["theme"];

/** Visual state of a node, combining the step status with its agent's live state. */
export type NodeState = StepStatus | "definition" | "needs_permission";

export function nodeColor(theme: Theme, state: NodeState): string {
  switch (state) {
    case "completed":
      return semanticColor(theme, "done");
    case "failed":
      return semanticColor(theme, "failed");
    case "waiting":
    case "needs_permission":
    case "reported":
      return semanticColor(theme, "waiting");
    case "running":
      return semanticColor(theme, "running");
    case "ready":
      return theme.colors.foreground;
    default:
      return theme.colors.border;
  }
}

/** The kind of a step as an icon (Lucide name) and a word. The icon never stands alone: the word always goes with it. */
export const STEP_KINDS = {
  agent: { icon: "Bot", label: "Agent" },
  script: { icon: "Terminal", label: "Script" },
  gate: { icon: "Hand", label: "Gate" },
  handoff: { icon: "Send", label: "Hand-off" },
  branch: { icon: "GitBranch", label: "Branch" },
  fanout: { icon: "Split", label: "Fan-out" },
} as const;

export function nodeIcon(state: NodeState): string {
  switch (state) {
    case "completed":
      return "Check";
    case "failed":
      return "X";
    case "running":
      return "Loader";
    case "waiting":
    case "queued":
      return "Hourglass";
    case "reported":
      return "MessageSquare";
    case "needs_permission":
      return "ShieldAlert";
    case "ready":
      return "CirclePlay";
    case "skipped":
      return "SkipForward";
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
    case "queued":
      return "waiting for a free slot";
    case "skipped":
      return "skipped";
    case "definition":
      return "";
    default:
      return state;
  }
}

export function runStatusLabel(status: RunStatus): string {
  return status === "waiting_gate" ? "waiting for approval" : status === "boarding" ? "waiting list" : status;
}

export function runStatusTone(status: RunStatus): SemanticTone {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
    case "canceled":
      return "failed";
    case "waiting_gate":
    case "boarding":
      return "waiting";
    default:
      return "running";
  }
}

export function runStatusColor(theme: Theme, status: RunStatus): string {
  return semanticColor(theme, runStatusTone(status));
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

/** Human gates: a light tint of the waiting colour, or surface0 if it cannot be tinted. */
export function gateBackground(theme: Theme): string {
  return withAlpha(semanticColor(theme, "waiting"), 0.14) ?? theme.colors.surface0;
}

export { stepLabel, stepShortTitle, stepTitle, stepTitleOf } from "../shared/labels";
