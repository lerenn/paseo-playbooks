import type { Attempt, Role, Run, Step } from "./types";

/** The step sheet shows a received input at most this long, so the lean list keeps exactly that much. */
const INPUT_SHOWN = 300;

type StepState = Run["steps"][string];

/** The heavy fields of an attempt the lean list defers: the sheet fetches them (`runs.step-detail`). */
const HEAVY = ["prompt", "inputs", "report", "lastMessage"] as const;

function leanAttempt(attempt: Attempt, latest: boolean): Attempt {
  // Only the latest attempt's inputs, report and last message are displayed (step sheet, graph card); the others are listed by outcome.
  if (!latest) return { ...attempt, prompt: "", inputs: {}, report: attempt.report && { ...attempt.report, summary: "", outputs: {} }, lastMessage: null };
  return {
    ...attempt,
    prompt: "",
    inputs: Object.fromEntries(Object.entries(attempt.inputs).map(([name, input]) => [name, input.value.length > INPUT_SHOWN ? { ...input, value: input.value.slice(0, INPUT_SHOWN) } : input])),
  };
}

/**
 * A run as the panel lists it: the same document with the heavy, rarely displayed text left out
 * (the history but the skipped-step entries, attempt prompts, earlier attempts' reports, inputs and last messages, role instructions, step prompts).
 * The step sheet gets them with `runs.step-detail`. Nothing the lists and the graph display is dropped.
 */
export function leanRun(run: Run): Run {
  return {
    ...run,
    // The panel reads one kind of history entry (why a step was skipped, in the step sheet); the rest is for the agents' get_run.
    history: run.history.filter((entry) => entry.type === "step_skipped"),
    playbook: {
      ...run.playbook,
      roles: Object.fromEntries(Object.entries(run.playbook.roles).map(([id, role]) => [id, { ...role, instructions: "" }])),
      steps: run.playbook.steps.map((step) => (step.prompt ? { ...step, prompt: "" } : step)),
    },
    steps: Object.fromEntries(Object.entries(run.steps).map(([id, state]) => [id, { ...state, attempts: state.attempts.map((attempt, index) => leanAttempt(attempt, index === state.attempts.length - 1)) }])),
  };
}

/** What the step sheet fetches when it opens: the step's full state, its definition and its role. */
export interface StepDetail {
  state: StepState;
  step: Step;
  role: Role | null;
}

export function stepDetail(run: Run, stepId: string): StepDetail | null {
  const state = run.steps[stepId];
  const step = run.playbook.steps.find((candidate) => candidate.id === stepId);
  if (!state || !step) return null;
  return { state, step, role: step.role ? (run.playbook.roles[step.role] ?? null) : null };
}

/**
 * The lean state with the heavy fields filled in from the detail. The lean list is always the
 * newer of the two, so it decides what exists (attempts, status); the detail only adds text, and
 * only to an attempt it has in the same shape (a report that appeared since is not blanked or invented).
 */
export function withDetail(lean: StepState, detail: StepState | undefined): StepState {
  if (!detail) return lean;
  return {
    ...lean,
    attempts: lean.attempts.map((attempt) => {
      const full = detail.attempts.find((candidate) => candidate.n === attempt.n);
      if (!full || (full.report === null) !== (attempt.report === null)) return attempt;
      return { ...attempt, ...Object.fromEntries(HEAVY.map((key) => [key, full[key]])) };
    }),
  };
}
