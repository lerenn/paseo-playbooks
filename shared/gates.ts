import type { GateChoice, Playbook, Step } from "./types";

/** Choices of a gate step that declares none in its YAML. */
export const DEFAULT_GATE_CHOICES: GateChoice[] = [
  { id: "approved", label: "Approve", comment: "none" },
  { id: "rejected", label: "Reject", comment: "optional", color: "danger" },
];

/** Choices of a loop-limit gate (the playbook's loop ran out of `max_loops`). */
export const LOOP_LIMIT_CHOICES: GateChoice[] = [
  { id: "approved", label: "Allow one more loop", comment: "none" },
  { id: "rejected", label: "Stop and fail the run", comment: "optional", color: "danger" },
];

export function gateChoices(step: Step): GateChoice[] {
  return step.choices.length > 0 ? step.choices : DEFAULT_GATE_CHOICES;
}

/** Where a gate outcome leads: "next", "end", "fail" or "goto", with display names of the targets. */
export interface Destination {
  kind: "next" | "end" | "fail" | "goto";
  targets: string[];
}

/** The transition an outcome takes: its `on` entry, else the first outcome continues and the others fail. */
export function outcomeTransition(step: Step, outcome: string) {
  return step.on[outcome] ?? (outcome === step.outcomes[0] ? ({ kind: "complete" } as const) : ({ kind: "fail" } as const));
}

export function destinationOf(playbook: Playbook, step: Step, outcome: string): Destination {
  const transition = outcomeTransition(step, outcome);
  switch (transition.kind) {
    case "goto":
      return { kind: "goto", targets: [transition.target] };
    case "end":
      return { kind: "end", targets: [] };
    case "fail":
      return { kind: "fail", targets: [] };
    default: {
      const next = playbook.steps.filter((candidate) => candidate.needs.includes(step.id)).map((candidate) => candidate.id);
      return next.length > 0 ? { kind: "next", targets: next } : { kind: "end", targets: [] };
    }
  }
}
