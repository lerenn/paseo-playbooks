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

export const TransitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }),
  z.object({ kind: z.literal("end") }),
  z.object({ kind: z.literal("fail") }),
  z.object({ kind: z.literal("goto"), target: z.string(), maxLoops: z.number().int().positive().optional() }),
  /** Opens a human gate asking for an answer, then goes back to `target` with the answer as feedback. */
  z.object({ kind: z.literal("ask"), ask: z.string(), target: z.string(), maxLoops: z.number().int().positive().optional() }),
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

export const StepSchema = z.object({
  id: z.string(),
  kind: z.enum(["agent", "gate"]),
  role: z.string().optional(),
  gate: z.string().optional(),
  needs: z.array(z.string()),
  prompt: z.string(),
  inputs: z.record(z.string(), InputWiringSchema),
  outputs: z.record(z.string(), VarDefSchema),
  outcomes: z.array(z.string()),
  retries: z.number().int().min(0),
  timeoutMs: z.number().int().positive().optional(),
  /** Resolved agent settings (step > role > playbook > defaults). Provider/model may stay unset. */
  agent: AgentSettingsSchema,
  on: z.record(z.string(), TransitionSchema),
  /** Gate steps: the choices offered, in order (empty = the default Approve / Reject). */
  choices: z.array(GateChoiceSchema).default([]),
});
export type Step = z.infer<typeof StepSchema>;

export const PlaybookOutputSchema = VarDefSchema.extend({
  source: z.string(),
  auto: z.boolean(),
  label: z.string(),
});

export const NextSchema = z.object({
  playbook: z.string(),
  on: z.literal("completed"),
  /** Explicit mappings (templates over `outputs.<name>` and `inputs.<name>`); others auto-match. */
  inputs: z.record(z.string(), z.string()),
});

export const PlaybookSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  file: z.string(),
  inputs: z.record(z.string(), VarDefSchema),
  outputs: z.record(z.string(), PlaybookOutputSchema),
  next: z.array(NextSchema),
  concurrency: z.number().int().positive().optional(),
  steps: z.array(StepSchema),
  roles: z.record(z.string(), RoleSchema),
  manager: AgentSettingsSchema,
  /**
   * Sub-playbooks expanded into this one, by id prefix ("pr", or "release.deploy" when
   * nested): their steps are named "<prefix>.<step>". Used to draw a frame around them.
   */
  blocks: z
    .record(z.string(), z.object({ title: z.string(), playbook: z.string(), concurrency: z.number().int().positive().optional() }))
    .default({}),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

/** One playbook file as seen by the panel and `list_playbooks`: valid or with errors. */
export const PlaybookEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  title: z.string(),
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
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

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
  /** For loop_limit and ask gates: the step the goto leads to. */
  gotoTarget: z.string().nullable(),
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
  steps: z.record(z.string(), RunStepSchema),
  /** Times each goto edge fired, keyed "source->target", and extra loops granted at a loop-limit gate. */
  loops: z.record(z.string(), z.number().int()),
  loopAllowance: z.record(z.string(), z.number().int()),
  gates: z.array(GateSchema),
  inbox: z.array(z.string()),
  history: z.array(HistoryEventSchema),
  seq: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "canceled"];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}
