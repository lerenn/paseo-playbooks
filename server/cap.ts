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

/** Checks the manager and every agent step against the cap: one error per disallowed provider/mode, listing who uses it. */
export function checkModes(cap: Cap, manager: AgentSettings, steps: readonly Step[]): string[] {
  const users = new Map<string, { provider: string; mode: string; who: string[] }>();
  const note = (provider: string, mode: string | undefined, who: string) => {
    if (mode === undefined || modeViolation(cap, provider, mode) === null) return;
    const key = `${provider}\u0000${mode}`;
    const entry = users.get(key) ?? { provider, mode, who: [] };
    entry.who.push(who);
    users.set(key, entry);
  };
  note(manager.provider ?? DEFAULT_PROVIDER, manager.mode, "the manager");
  for (const step of steps) {
    if (step.kind === "agent") note(step.agent.provider ?? manager.provider ?? DEFAULT_PROVIDER, step.agent.mode, `"${step.id}"`);
  }
  return [...users.values()].map(({ provider, mode, who }) => {
    const stepNames = who.filter((name) => name !== "the manager");
    const stepsPart = stepNames.length === 0 ? "" : `${stepNames.length === 1 ? "step" : "steps"} ${stepNames.join(", ")}`;
    const subject = who.includes("the manager") ? (stepsPart ? `the manager and ${stepsPart}` : "the manager") : stepsPart;
    return `${subject}: ${modeViolation(cap, provider, mode)}`;
  });
}
