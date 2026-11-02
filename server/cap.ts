import type { AgentSettings, Step } from "../shared/types";
import type { CapValues } from "../shared/settings";

export type Cap = CapValues;

/** Fallback provider when neither the playbook nor the manager names one. */
export const DEFAULT_PROVIDER = "claude";
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Error message when `mode` on `provider` exceeds the cap, else null. */
export function modeViolation(cap: Cap, provider: string, mode: string | undefined): string | null {
  if (mode === undefined) return null;
  const allowed = cap.allowedModes[provider] ?? [];
  if (allowed.includes(mode)) return null;
  return `mode "${mode}" on provider "${provider}" is not allowed by this daemon (allowed: ${allowed.join(", ") || "none"}); the daemon owner can allow it in Settings → Plugins → paseo-playbooks`;
}

/** Checks the manager and every agent step against the cap. */
export function checkModes(cap: Cap, manager: AgentSettings, steps: readonly Step[]): string[] {
  const errors: string[] = [];
  const managerProblem = modeViolation(cap, manager.provider ?? DEFAULT_PROVIDER, manager.mode);
  if (managerProblem) errors.push(`manager: ${managerProblem}`);
  for (const step of steps) {
    if (step.kind !== "agent") continue;
    const problem = modeViolation(cap, step.agent.provider ?? manager.provider ?? DEFAULT_PROVIDER, step.agent.mode);
    if (problem) errors.push(`step "${step.id}": ${problem}`);
  }
  return errors;
}
