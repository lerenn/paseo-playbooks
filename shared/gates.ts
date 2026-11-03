import { innermostBlock } from "./slots";
import type { Gate, GateChoice, Playbook, Step } from "./types";

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

/** The single choice of an `ask` gate: the answer, required, becomes the feedback of the step it goes back to. */
export const ASK_CHOICES: GateChoice[] = [{ id: "answered", label: "Send answer", comment: "required" }];

/**
 * Where a gate outcome leads: "next", "end" (the run), "end_block" (an `end` inside a
 * sub-playbook block ends only that block; targets holds its prefix), "fail" or "goto".
 */
export interface Destination {
  kind: "next" | "end" | "end_block" | "fail" | "goto";
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
    case "ask":
      return { kind: "goto", targets: [transition.target] };
    case "end": {
      const block = innermostBlock(playbook, step.id);
      return block === null ? { kind: "end", targets: [] } : { kind: "end_block", targets: [block] };
    }
    case "fail":
      return { kind: "fail", targets: [] };
    default: {
      const next = playbook.steps.filter((candidate) => candidate.needs.includes(step.id)).map((candidate) => candidate.id);
      return next.length > 0 ? { kind: "next", targets: next } : { kind: "end", targets: [] };
    }
  }
}

/** Longest summary request_gate accepts: one short sentence. */
export const GATE_SUMMARY_MAX = 160;

/** Splits text after its first sentence ("." "!" "?" followed by a space and a capital, a digit or a quote). */
function firstSentence(text: string): [string, string] {
  const match = /^([\s\S]*?[.!?])\s+(?=[A-Z0-9"'(`])/.exec(text);
  return match ? [match[1]!.trim(), text.slice(match[0].length).trim()] : [text.trim(), ""];
}

/**
 * A gate's one-sentence summary and its details. Long summaries keep their first sentence; the
 * rest moves to the top of the details. Gates from before the split fall back to their first paragraph.
 */
export function gateText(gate: Gate): { summary: string; details: string } {
  let summary = gate.summary;
  let details = gate.details;
  if (!summary) {
    const [first = "", ...rest] = gate.message.split(/\n\s*\n/);
    summary = first.trim();
    details = rest.join("\n\n").trim();
  }
  const [sentence, more] = firstSentence(summary);
  if (more) details = [more, details].filter(Boolean).join("\n\n");
  return { summary: sentence, details };
}

/** Turns bare http(s) URLs into Markdown autolinks so they render clickable; existing links are left alone. */
export function linkify(text: string): string {
  return text.replace(/(?<!\]\()(?<![<\w/])https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g, (url) => `<${url}>`);
}
