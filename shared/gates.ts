import { innermostBlock } from "./slots";
import type { AskChoice, Gate, GateChoice, Playbook, Step, Transition } from "./types";

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

export function gateChoices(step: Pick<Step, "choices">): GateChoice[] {
  return step.choices.length > 0 ? step.choices : DEFAULT_GATE_CHOICES;
}

/**
 * The choices of an `admission` gate (a job a stage's admission script escalated): check again and keep holding it,
 * take it out of the pipeline, or let it join anyway.
 */
export const ADMISSION_CHOICES: GateChoice[] = [
  { id: "retry", label: "Check again", comment: "optional" },
  { id: "withdraw", label: "Withdraw the job", comment: "optional", color: "danger" },
  { id: "admit", label: "Admit anyway", comment: "optional", color: "warning" },
];

/** The choices of a `permission` gate (an agent's tool permission request, `permissions.on_request: escalate`). */
export const PERMISSION_CHOICES: GateChoice[] = [
  { id: "allow", label: "Allow", comment: "none" },
  { id: "deny", label: "Deny", comment: "optional", color: "danger" },
];

/**
 * The choices of a `manager_question` gate (the manager's open question): one button per option, plus "Something else" (a typed answer);
 * a question without options takes a typed answer; a request the panel cannot answer (several questions, multi-select) has none.
 */
export function managerQuestionChoices(question: Gate["question"]): GateChoice[] {
  if (!question || !question.answerable) return [];
  if (question.options.length === 0) return [{ id: "answered", label: "Send answer", comment: "required" }];
  return [
    ...question.options.map((option, index) => ({ id: `option-${index + 1}`, label: option.label, comment: "none" as const })),
    { id: "other", label: "Something else", comment: "required" as const },
  ];
}

/** The answer a `manager_question` choice gives the manager: the option's label, or the typed text. */
export function managerQuestionAnswer(question: NonNullable<Gate["question"]>, choiceId: string, comment: string | null): string {
  if (choiceId === "other" || choiceId === "answered") return (comment ?? "").trim();
  const index = Number(choiceId.replace(/^option-/, "")) - 1;
  return question.options[index]?.label ?? "";
}

/** The single choice of an `ask` gate without `choices`: the answer, required, becomes the feedback of the step it goes back to. */
export const ASK_CHOICES: GateChoice[] = [{ id: "answered", label: "Send answer", comment: "required" }];

type AskTransition = Extract<Transition, { kind: "ask" }>;

/** The buttons of an `ask` transition, each with where it goes: its `choices`, else the single "answered". */
export function askChoices(transition: AskTransition): AskChoice[] {
  if (transition.choices && transition.choices.length > 0) return transition.choices;
  return ASK_CHOICES.map((choice) => ({ ...choice, target: transition.target, ...(transition.maxLoops !== undefined ? { maxLoops: transition.maxLoops } : {}) }));
}

/** The `ask` transition that opened an ask gate: by its outcome, else (older gates) by its target. */
export function askTransitionOf(gate: Gate, step: Pick<Step, "on"> | undefined): AskTransition | null {
  if (!step) return null;
  const byOutcome = gate.outcome ? step.on[gate.outcome] : undefined;
  if (byOutcome?.kind === "ask") return byOutcome;
  const found = Object.values(step.on).find((transition) => transition.kind === "ask" && transition.target === gate.gotoTarget);
  return found?.kind === "ask" ? found : null;
}

/** The choices of an open gate: its step's, the fixed ones of loop-limit gates, or the ask's. */
export function choicesOfGate(gate: Gate, step: Pick<Step, "on" | "choices"> | undefined): GateChoice[] {
  if (gate.kind === "loop_limit") return LOOP_LIMIT_CHOICES;
  if (gate.kind === "admission") return ADMISSION_CHOICES;
  if (gate.kind === "permission") return PERMISSION_CHOICES;
  if (gate.kind === "manager_question") return managerQuestionChoices(gate.question);
  if (gate.kind === "ask") {
    const transition = askTransitionOf(gate, step);
    return transition ? askChoices(transition) : ASK_CHOICES;
  }
  return step ? gateChoices(step) : [];
}

/**
 * Tells the manager to ask the human in chat too: a question from the agent puts the workspace
 * in "needs input" (the yellow dot and a push), which an agent that just ends its turn does not.
 */
/**
 * An open gate a human may be asked for: not one a role decider still holds. A manager
 * decider leaves a gate to a human just by asking, which the plugin cannot see, so its gates count.
 */
export function waitsForHuman(gate: Gate): boolean {
  return gate.status === "pending" && !(gate.decider?.by === "role" && gate.escalated === null);
}

/** An open gate a human set aside with a reason and a waiting condition (Waiting, not Needs you). It can still be decided. */
export function isDeferred(gate: Gate): boolean {
  return gate.status === "pending" && gate.deferral != null && gate.deferral.returnedAt == null;
}

/** An open gate a human is asked to decide now: counted in Needs you. */
export function needsReview(gate: Gate): boolean {
  return waitsForHuman(gate) && !isDeferred(gate);
}

/** The gates of Waiting: open, awaiting a human, deferred. */
export function isWaiting(gate: Gate): boolean {
  return waitsForHuman(gate) && isDeferred(gate);
}

/** Whether the plugin itself tracks a condition (it returns the gate to review on its own). */
export function isTracked(condition: NonNullable<Gate["deferral"]>["condition"]): boolean {
  return condition.kind !== "manual";
}

export function describeCondition(deferral: NonNullable<Gate["deferral"]>): string {
  const c = deferral.condition;
  const base =
    c.kind === "manual" ? `Manual: nothing tracks this${c.note ? ` (${c.note})` : ""}; bring it back yourself` :
    c.kind === "date" ? `Tracked: back to review at ${c.at}` :
    c.kind === "run_ended" ? `Tracked: back when run ${c.runId} ends` :
    `Tracked: back when gate ${c.gateId} of run ${c.runId} is decided`;
  return deferral.remindAt && c.kind !== "date" ? `${base}; reminder ${deferral.remindAt}` : base;
}

export function askHumanText(gate: Gate, choices: GateChoice[]): string {
  const options = choices
    .map((choice) => `"${choice.id}" (${choice.label}${choice.comment === "required" ? ", needs a comment" : ""})`)
    .join(", ");
  const by = gate.decider?.by ?? "human";
  if (by === "role" && gate.escalated === null) {
    return `Role "${gate.decider.role}" decides this gate: the plugin started an agent for it. Do not ask a human and do not call resume. End your turn; you are woken with its decision, or with the gate if it leaves it to a human.`;
  }
  if (by === "manager" && gate.escalated === null) {
    return `You may decide this gate yourself: if the run gives you enough to choose, call resume for gate ${gate.id} with byManager: true, one of ${options}, and your reason as comment. Otherwise leave it to a human: ask the human now with your tool for asking the user a question (AskUserQuestion, request_user_input or the like), the gate summary as the question and one option per choice, then call resume with the chosen id and their words as comment.`;
  }
  return `Ask the human now with your tool for asking the user a question (AskUserQuestion, request_user_input or the like): the gate summary as the question, one option per choice: ${options}. Then call resume for gate ${gate.id} with the chosen id and their words as comment. If you have no such tool, tell the human and end your turn.`;
}

/**
 * Where a gate outcome leads: "next", "end" (the run), "end_block" (an `end` inside a
 * sub-playbook block ends only that block; targets holds its prefix), "fail" or "goto".
 */
export interface Destination {
  kind: "next" | "end" | "end_block" | "fail" | "goto";
  targets: string[];
}

/**
 * The transition an outcome takes: its `on` entry, else the first outcome continues. The
 * validator requires an `on` entry for every other choice, except the default gate's
 * `rejected` (and loop-limit rejects), which fail the run: the fallback below.
 */
export function outcomeTransition(step: Pick<Step, "on" | "outcomes">, outcome: string) {
  return step.on[outcome] ?? (outcome === step.outcomes[0] ? ({ kind: "complete" } as const) : ({ kind: "fail" } as const));
}

export function destinationOf(playbook: Pick<Playbook, "blocks"> & { steps: Array<Pick<Step, "id" | "needs">> }, step: Pick<Step, "id" | "on" | "outcomes">, outcome: string): Destination {
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
