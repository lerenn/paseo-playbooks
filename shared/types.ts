import { z } from "zod";

/** Plain values that inputs and outputs carry. */
export const VarValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type VarValue = z.infer<typeof VarValueSchema>;

export const VarTypeSchema = z.enum(["string", "number", "boolean", "enum"]);
export type VarType = z.infer<typeof VarTypeSchema>;

export const VarDefSchema = z.object({
  type: VarTypeSchema,
  values: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  default: VarValueSchema.optional(),
  description: z.string().optional(),
});
export type VarDef = z.infer<typeof VarDefSchema>;

export const AgentSettingsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  mode: z.string().optional(),
  thinking: z.string().optional(),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

/** A button on a human gate. Its id is the outcome; where it leads comes from the step's `on`. */
export const GateChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Whether pressing it asks for a comment first (sent to the manager and, on a goto, to the target step). */
  comment: z.enum(["none", "optional", "required"]),
  /** Theme colour of the button; unset = primary for the first choice, neutral for the others. */
  color: z.enum(["primary", "neutral", "success", "warning", "danger"]).optional(),
});
export type GateChoice = z.infer<typeof GateChoiceSchema>;

/** A choice of an `ask` gate: a button that goes to its own `target` with the comment as feedback. */
export const AskChoiceSchema = GateChoiceSchema.extend({ target: z.string(), maxLoops: z.number().int().positive().optional() });
export type AskChoice = z.infer<typeof AskChoiceSchema>;

export const TransitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }),
  /**
   * Ends the playbook the step is written in. `outcome` (one of the playbook's `outcomes`) is
   * what a sub-playbook block reports to its parent step's `on`; unset = the first outcome.
   */
  z.object({ kind: z.literal("end"), outcome: z.string().optional() }),
  z.object({ kind: z.literal("fail") }),
  z.object({ kind: z.literal("goto"), target: z.string(), maxLoops: z.number().int().positive().optional() }),
  /**
   * Opens a human gate asking for an answer, then goes back to `target` with the answer as feedback.
   * With `choices`, each button goes to its own target; `target` is then the first choice's.
   */
  z.object({
    kind: z.literal("ask"),
    ask: z.string(),
    target: z.string(),
    maxLoops: z.number().int().positive().optional(),
    choices: z.array(AskChoiceSchema).optional(),
  }),
]);
export type Transition = z.infer<typeof TransitionSchema>;

/** Where a step input takes its value from, after auto-matching. */
export const InputWiringSchema = z.object({
  /** Template rendered against `playbook.inputs` and `steps.<id>.outputs`. */
  source: z.string(),
  /** True when the source was found by name rather than written in the YAML. */
  auto: z.boolean(),
  /** Human label, e.g. "implement.pr_url" or "playbook.request". */
  label: z.string(),
  type: VarTypeSchema.optional(),
});
export type InputWiring = z.infer<typeof InputWiringSchema>;

export const RoleSchema = z.object({
  id: z.string(),
  title: z.string(),
  readonly: z.boolean(),
  instructions: z.string(),
  agent: AgentSettingsSchema,
});
export type Role = z.infer<typeof RoleSchema>;


export const StepSchema = z.object({
  id: z.string(),
  /** Full name (details panel, graph). Unset = stepLabel(id). */
  title: z.string().optional(),
  /** Name in the Playbooks screen columns. Unset = the title. */
  shortTitle: z.string().optional(),
  kind: z.enum(["agent", "gate", "script"]),
  role: z.string().optional(),
  gate: z.string().optional(),
  /** Script steps: the executable, relative to the workspace (`<playbooks folder>/scripts/<name>`). */
  script: z.string().optional(),
  /** Script steps: rerun the script this often while it exits with SCRIPT_NOT_YET. Unset = run it once. */
  pollMs: z.number().int().positive().optional(),
  needs: z.array(z.string()),
  prompt: z.string(),
  inputs: z.record(z.string(), InputWiringSchema),
  outputs: z.record(z.string(), VarDefSchema),
  outcomes: z.array(z.string()),
  retries: z.number().int().min(0),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * A templated `timeout` ("{{ inputs.release_timeout }}"), rendered with the step's inputs when
   * an attempt starts. `timeoutMs` is then the fallback (the defaults' timeout) for an empty value.
   */
  timeout: z.string().optional(),
  /** Agent steps: remind the agent after this long without activity. 0 = never; unset = the plugin default. */
  silenceMs: z.number().int().min(0).optional(),
  /** Resolved agent settings (step > role > playbook > defaults). Provider/model may stay unset. */
  agent: AgentSettingsSchema,
  on: z.record(z.string(), TransitionSchema),
  /** Gate steps: the choices offered, in order (empty = the default Approve / Reject). */
  choices: z.array(GateChoiceSchema).default([]),
  /** Set on the steps of an after-task: the task's id. Unset = a step of the main graph. */
  afterTask: z.string().optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const PlaybookOutputSchema = VarDefSchema.extend({
  source: z.string(),
  auto: z.boolean(),
  label: z.string(),
});

export const AfterTriggerSchema = z.enum(["auto", "manual"]);

/** A task run once the main graph has ended: it never changes the run's status. */
export const AfterTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** auto: starts when the run completes or fails. manual: a human starts it from the panel, or asks an agent (start_after_task). */
  trigger: AfterTriggerSchema,
  /** Its steps in `Playbook.steps` (one for an agent or gate task, the expanded steps of a sub-playbook). */
  steps: z.array(z.string()),
});
export type AfterTask = z.infer<typeof AfterTaskSchema>;

export const PlaybookSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  file: z.string(),
  inputs: z.record(z.string(), VarDefSchema),
  outputs: z.record(z.string(), PlaybookOutputSchema),
  concurrency: z.number().int().positive().optional(),
  /**
   * How the playbook can end, as seen by a parent that uses it as a sub-playbook. The first is
   * a normal finish (all steps done, or a plain `end`); `{ end: <outcome> }` picks another.
   */
  outcomes: z.array(z.string()).default(["success"]),
  steps: z.array(StepSchema),
  roles: z.record(z.string(), RoleSchema),
  manager: AgentSettingsSchema,
  /**
   * Sub-playbooks expanded into this one, by id prefix ("pr", or "release.deploy" when
   * nested): their steps are named "<prefix>.<step>". Used to draw a frame around them.
   */
  blocks: z
    .record(
      z.string(),
      z.object({
        title: z.string(),
        playbook: z.string(),
        concurrency: z.number().int().positive().optional(),
        /** The sub-playbook's outcomes (first = a normal finish). Unset on runs from before block outcomes. */
        outcomes: z.array(z.string()).optional(),
        /** The playbook step's `on`: where each other outcome of the block leads (complete, end or fail). */
        on: z.record(z.string(), TransitionSchema).optional(),
      }),
    )
    .default({}),
  /** After-tasks, in file order. Their steps are in `steps`, marked with `afterTask`. */
  after: z.array(AfterTaskSchema).default([]),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

/** One playbook file as seen by the panel and `list_playbooks`: valid or with errors. */
export const PlaybookEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  title: z.string(),
  /** `hidden: true` in the YAML: listed in the panel's collapsed "Hidden playbooks" section (still startable, still usable as a sub-playbook). */
  hidden: z.boolean().default(false),
  errors: z.array(z.string()),
  playbook: PlaybookSchema.nullable(),
});
export type PlaybookEntry = z.infer<typeof PlaybookEntrySchema>;

// ---------------------------------------------------------------- run state

export const StepStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "reported",
  "completed",
  "failed",
  "waiting",
  /** Ready, but its sub-playbook's `concurrency` slots are all held by other runs. */
  "queued",
  /** Not run: an `end` inside its sub-playbook block ended the block first. Counts as done. */
  "skipped",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** Completed, or skipped by an `end` in its block: either way it no longer blocks what needs it. */
export function isStepDone(status: StepStatus): boolean {
  return status === "completed" || status === "skipped";
}

export const TurnEndSchema = z.enum(["completed", "failed", "canceled", "lost", "timeout"]);

export const ReportSchema = z.object({
  outcome: z.string(),
  summary: z.string(),
  outputs: z.record(z.string(), VarValueSchema),
});
export type Report = z.infer<typeof ReportSchema>;

export const AttemptSchema = z.object({
  n: z.number().int().positive(),
  agentId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  brief: z.string(),
  inputs: z.record(z.string(), z.object({ value: z.string(), source: z.string() })),
  report: ReportSchema.nullable(),
  /** Last assistant text when the agent ended without reporting. */
  lastMessage: z.string().nullable(),
  outcome: z.string().nullable(),
  turnEnd: TurnEndSchema.nullable(),
  /** Git state captured before a readonly step, compared at the end. */
  readonlySnapshot: z.string().nullable(),
  /** True once the plugin asked the agent to report after a turn ended without a report. */
  reminded: z.boolean().default(false),
  /** True once the plugin asked a silent (or nearly timed-out) running agent to report or say what it waits for. */
  silenceReminded: z.boolean().default(false),
  /** When nudge_step reopened the attempt after it ended; its timeout and silence count from here. */
  reopenedAt: z.string().nullable().default(null),
  /** The timeout of this attempt (a templated `timeout` resolved at its start); null = the step's `timeoutMs`. */
  timeoutMs: z.number().int().positive().nullable().default(null),
  /** Script steps: how many times the script has run in this attempt. */
  checks: z.number().int().min(0).default(0),
  /** Script steps: when the next check runs, while the script says "not yet". */
  nextCheckAt: z.string().nullable().default(null),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const RunStepSchema = z.object({
  status: StepStatusSchema,
  attempts: z.array(AttemptSchema),
  /** Resolved outputs of the latest completed attempt. */
  outputs: z.record(z.string(), VarValueSchema),
  summary: z.string().nullable(),
  /** Feedback injected into the next attempt after a goto. */
  feedback: z.string().nullable(),
  completedSeq: z.number().int().nullable(),
  /** When the step started waiting for a free `concurrency` slot of its block (orders the queue). */
  queuedAt: z.string().nullable().default(null),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const GateSchema = z.object({
  id: z.string(),
  kind: z.enum(["gate", "loop_limit", "ask"]),
  stepId: z.string(),
  /** For loop_limit and ask gates: the step the goto leads to (an ask gate's first choice's). */
  gotoTarget: z.string().nullable(),
  /** For ask gates: the step outcome that opened it (null on gates opened before it existed). */
  outcome: z.string().nullable().default(null),
  /** "pending", or the chosen outcome (a choice id; "approved" / "rejected" for loop-limit gates). */
  status: z.string(),
  /** Full text (summary then details), as sent by chat. */
  message: z.string(),
  /** One sentence shown on the gate; empty on gates opened before it existed. */
  summary: z.string().default(""),
  /** Longer text, collapsed under the summary: the playbook's gate text, then the manager's details. */
  details: z.string().default(""),
  requestedAt: z.string(),
  comment: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedVia: z.enum(["panel", "chat"]).nullable(),
  decidedAt: z.string().nullable(),
});
export type Gate = z.infer<typeof GateSchema>;

export const RunStatusSchema = z.enum(["running", "waiting_gate", "completed", "failed", "canceled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AfterTaskStatusSchema = z.enum(["pending", "running", "completed", "failed", "canceled"]);
export type AfterTaskStatus = z.infer<typeof AfterTaskStatusSchema>;

export const RunAfterTaskSchema = z.object({
  status: AfterTaskStatusSchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Why it failed or was canceled. */
  detail: z.string().nullable(),
});
export type RunAfterTask = z.infer<typeof RunAfterTaskSchema>;

export const HistoryEventSchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  stepId: z.string().nullable(),
  detail: z.string(),
});

export const RunSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  playbook: PlaybookSchema,
  workspaceId: z.string(),
  workspaceDir: z.string(),
  projectId: z.string(),
  branch: z.string().nullable(),
  managerAgentId: z.string(),
  inputs: z.record(z.string(), VarValueSchema),
  outputs: z.record(z.string(), VarValueSchema).nullable(),
  status: RunStatusSchema,
  failure: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set when the run is archived from the panel: hidden there, its state and agents kept. */
  archivedAt: z.string().nullable().default(null),
  /** Set when a human first opens the finished run from the Playbooks screen: done runs turn from green to grey. */
  seenAt: z.string().nullable().default(null),
  /** Set while a human has paused the run: no step starts and the manager is not woken until resume. */
  pausedAt: z.string().nullable().default(null),
  steps: z.record(z.string(), RunStepSchema),
  /** Times each goto edge fired, keyed "source->target", and extra loops granted at a loop-limit gate. */
  loops: z.record(z.string(), z.number().int()),
  loopAllowance: z.record(z.string(), z.number().int()),
  gates: z.array(GateSchema),
  /** State of each after-task, by id. Runs created before after-tasks have none. */
  after: z.record(z.string(), RunAfterTaskSchema).default({}),
  inbox: z.array(z.string()),
  history: z.array(HistoryEventSchema),
  seq: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

/** Exit code a script step uses to say "not done yet, run me again after `poll`" (EX_TEMPFAIL). */
export const SCRIPT_NOT_YET = 75;

/** Script steps have no agent: their attempts carry this id instead, unique across runs. */
export function scriptAttemptId(runId: string, stepId: string, attempt: number): string {
  return `script:${runId}:${stepId}:${attempt}`;
}

export function isScriptAttempt(agentId: string): boolean {
  return agentId.startsWith("script:");
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "canceled"];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** After-tasks of the run that are running now ("wrapping up"). */
export function runningAfterTasks(run: Run): string[] {
  return Object.entries(run.after).filter(([, task]) => task.status === "running").map(([id]) => id);
}

/**
 * Whether the run still has work going on: its main graph, or an after-task once it ended.
 * Use `isTerminal(run.status)` for the run's result, this for "can it still change".
 */
export function isActive(run: Run): boolean {
  return !isTerminal(run.status) || runningAfterTasks(run).length > 0;
}

/** Paused by a human and still active. A pause left on a run that has since ended means nothing. */
export function isPaused(run: Run): boolean {
  return run.pausedAt !== null && isActive(run);
}

/**
 * Why a finished run cannot be restarted from this step, or null when it can: the run has
 * ended (canceled or failed, or completed) with no after-task running, and the step is a main
 * step whose needs are all done (so its inputs exist). An archived run can be restarted: the
 * restart unarchives it.
 */
export function restartBlocker(run: Run, stepId: string): string | null {
  const step = run.playbook.steps.find((candidate) => candidate.id === stepId);
  if (!step) return `unknown step "${stepId}"`;
  if (!isTerminal(run.status)) return `run ${run.id} is ${run.status}; only a finished run can be restarted`;
  if (runningAfterTasks(run).length > 0) return `run ${run.id} is wrapping up (after-tasks running); wait or cancel them first`;
  if (step.afterTask) return `"${stepId}" belongs to the after-task "${step.afterTask}"; restart from a step of the main graph`;
  const missing = step.needs.filter((need) => !isStepDone(run.steps[need]?.status ?? "pending"));
  if (missing.length > 0) return `"${stepId}" needs ${missing.join(", ")}, which did not complete; restart from an earlier step`;
  return null;
}

/** A step attempt's timeout: resolved at its start, else the step's (attempts from before templated timeouts). */
export function attemptTimeoutMs(step: Step, attempt: Attempt): number | undefined {
  return attempt.timeoutMs ?? step.timeoutMs;
}

/** Whether a step can still move: a main step while the run is not finished, an after-step while its task runs. */
export function isStepLive(run: Run, stepId: string): boolean {
  const step = run.playbook.steps.find((candidate) => candidate.id === stepId);
  if (!step) return false;
  return step.afterTask ? run.after[step.afterTask]?.status === "running" : !isTerminal(run.status);
}
