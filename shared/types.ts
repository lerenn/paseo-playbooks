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

/** One provider/model an agent may run on. */
export const AgentTargetSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  mode: z.string().optional(),
  thinking: z.string().optional(),
});
export type AgentTarget = z.infer<typeof AgentTargetSchema>;

export const AgentSettingsSchema = AgentTargetSchema.extend({
  /** Targets tried, in order, after this one when its provider is out of tokens (the rest of a multi-entry tier). */
  fallback: z.array(AgentTargetSchema).optional(),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

/**
 * When the plugin sends `/compact` to a run's manager, once it is idle with an empty inbox:
 * never; after it handled a wake-up (`on_step`: a step ended, a gate was decided, ...); after a
 * gate was decided; or after either, when its context holds more than `above_tokens`.
 */
export const ManagerCompactSchema = z.union([
  z.enum(["never", "on_step", "on_gate_decided"]),
  z.object({ above_tokens: z.number().int().positive() }).strict(),
]);
export type ManagerCompact = z.infer<typeof ManagerCompactSchema>;
/** Used when neither the playbook nor `defaults/main.yaml` sets `manager.compact`. */
export const DEFAULT_MANAGER_COMPACT: ManagerCompact = { above_tokens: 150_000 };

/** How long a `provider/model` that ran out of tokens stays skipped (`providers.exhausted_for`). */
export const DEFAULT_EXHAUSTED_FOR_MS = 60 * 60 * 1000;

/** A `provider/model` that ran out of tokens, and when it was marked. A bare string (older run files) is marked at load time. */
export const ExhaustedEntrySchema = z.preprocess(
  (value) => (typeof value === "string" ? { target: value, at: new Date().toISOString() } : value),
  z.object({ target: z.string(), at: z.string() }),
);
export type ExhaustedEntry = z.infer<typeof ExhaustedEntrySchema>;

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

/**
 * A choice of an `ask` gate: a button that goes to its own `target` with the comment as feedback,
 * or, with `outcome`, ends the asking step with that outcome (its `on` entry) without running it
 * again. `outputs` are templates over `gate.*`, `report.*` and `inputs.*`, merged over the
 * step's last report; `target` is then unused.
 */
/** Who decides a gate: a human (the default), the manager, or an agent with a readonly role. Both may escalate to a human. */
export const GateDeciderSchema = z.object({
  by: z.enum(["human", "manager", "role"]),
  /** With `by: role`: the role's id. */
  role: z.string().optional(),
  /** With `by: role`: its agent settings, merged as a step's (defaults, playbook, role). */
  agent: AgentSettingsSchema.optional(),
});
export type GateDecider = z.infer<typeof GateDeciderSchema>;

export const AskChoiceSchema = GateChoiceSchema.extend({
  target: z.string(),
  maxLoops: z.number().int().positive().optional(),
  outcome: z.string().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});
export type AskChoice = z.infer<typeof AskChoiceSchema>;

export const TransitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }),
  /**
   * Ends the playbook the step is written in. `outcome` (one of the playbook's `outcomes`) is
   * what a sub-playbook block reports to its parent step's `on`; unset = the first outcome.
   */
  z.object({ kind: z.literal("end"), outcome: z.string().optional() }),
  z.object({ kind: z.literal("fail") }),
  /** `decider`: who decides the loop-limit gate `maxLoops` opens (unset = a human). */
  z.object({ kind: z.literal("goto"), target: z.string(), maxLoops: z.number().int().positive().optional(), decider: GateDeciderSchema.optional() }),
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
    /** Who answers the ask, and the loop-limit gates of its choices (unset = a human). */
    decider: GateDeciderSchema.optional(),
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


/**
 * A `when` condition of a step: the step runs only when the value `source` renders to (a run or
 * block input, after sub-playbook expansion) is one of `values`; otherwise it is skipped.
 */
export const WhenSchema = z.object({
  /** The input's name as written in the YAML, for messages. */
  input: z.string(),
  /** Template rendered against the run, e.g. "{{ playbook.inputs.env }}". */
  source: z.string(),
  values: z.array(z.string()),
  /** The step's own loop count (`when: { loop: ">=2" }`): it holds when any of these tests does. Then `source` and `values` are unused. */
  loop: z.array(z.object({ op: z.enum(["==", ">=", "<=", ">", "<"]), value: z.number().int().min(0) })).optional(),
  /** `{ empty: true }` / `{ empty: false }`: holds when the value is unset or "" (true) / set (false). Then `values` is unused. */
  empty: z.boolean().optional(),
});
export type When = z.infer<typeof WhenSchema>;

export const StepSchema = z.object({
  id: z.string(),
  /** Full name (details panel, graph). Unset = stepLabel(id). */
  title: z.string().optional(),
  /** Name in the Playbooks screen columns. Unset = the title. */
  shortTitle: z.string().optional(),
  kind: z.enum(["agent", "gate", "script", "handoff", "branch"]),
  role: z.string().optional(),
  gate: z.string().optional(),
  /** Script steps: the executable, relative to the workspace (`<playbooks folder>/scripts/<name>`). */
  script: z.string().optional(),
  /** Hand-off steps: the singleton playbook the step hands a job to. */
  handoff: z.string().optional(),
  /** Hand-off steps: false = done with the first outcome once the job is in the pipeline, which keeps it (fire and forget). Unset = wait for its result. */
  handoffWait: z.literal(false).optional(),
  /** Runs the step only when every condition holds; otherwise it is skipped. Unset = always. */
  when: z.array(WhenSchema).optional(),
  /**
   * Branch steps: ordered cases, the first whose conditions hold wins (a case without `when` is the
   * `else`, always last). The step completes at once with the winning case as its outcome.
   */
  branch: z.object({ cases: z.array(z.object({ name: z.string(), when: z.array(WhenSchema).optional() })) }).optional(),
  /** On a train of a singleton pipeline: the plugin settles its jobs from this output when the step completes. */
  settle: z.object({ output: z.string() }).optional(),
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
  /** Agent steps: archive the step's agents once it completes, and each attempt's once the next starts. Unset = true. */
  archiveAgents: z.boolean().optional(),
  /** Resolved agent settings (step > role > playbook > defaults). Provider/model may stay unset. */
  agent: AgentSettingsSchema,
  on: z.record(z.string(), TransitionSchema),
  /** Gate steps: the choices offered, in order (empty = the default Approve / Reject). */
  choices: z.array(GateChoiceSchema).default([]),
  /** Gate steps: who decides the gate (unset = a human). */
  decider: GateDeciderSchema.optional(),
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

/** A top-level step of a singleton: a waiting list of jobs, and one train at a time. */
export const StationSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Stations a job must have passed before it waits here. */
  needs: z.array(z.string()),
  /** fifo: one job per train, oldest first; merge: every waiting job per train. */
  mode: z.enum(["fifo", "merge"]),
  /** Failed trains a job may ride again here before it fails. */
  retries: z.number().int().min(0),
  /** Its steps in `Playbook.steps` (one, or the expanded steps of its sub-playbook). */
  steps: z.array(z.string()),
});
export type Station = z.infer<typeof StationSchema>;

/** `isolation:` of a playbook: `worktree` gives each run a private git worktree (see ADR 2026-11-09-isolation-worktree). */
export const IsolationSchema = z.object({
  mode: z.enum(["none", "worktree"]),
  /** Submodules to link into the worktree: none (agents init the ones they need), all, or these paths. */
  submodules: z.union([z.enum(["none", "all"]), z.array(z.string())]),
  /** Branch the worktree starts from (fresh origin copy); default: the project's default branch. */
  base: z.string().nullable(),
  /** false (default): a step whose branch deletes a submodule entry (gitlink, mode 160000) present in the base fails. */
  allowGitlinkRemoval: z.boolean().default(false),
});
export type Isolation = z.infer<typeof IsolationSchema>;
export const DEFAULT_ISOLATION: Isolation = { mode: "none", submodules: "none", base: null, allowGitlinkRemoval: false };

/** The private worktree of an isolated run, kept in run state. */
export const RunWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string(),
  /** The ref it was created from (e.g. origin/main) and that ref's commit. */
  base: z.string(),
  baseSha: z.string(),
  /** Submodule paths linked as worktrees of the workspace's own submodule clones. */
  linked: z.array(z.string()).default([]),
  /** HEAD and status of the original workspace checkout at run start: the isolation guard compares to it. */
  workspaceSnapshot: z.string().nullable(),
  /** active: exists; removed: the plugin deleted it; kept: it stays on disk (the history says why). */
  state: z.enum(["active", "removed", "kept"]),
});
export type RunWorktree = z.infer<typeof RunWorktreeSchema>;

/** Where an isolated run's playbook definition (and roles) came from: see ADR 2026-11-10-playbooks-from-fresh-main. */
export const RunDefinitionSchema = z.object({
  /** `origin`: read from the run's worktree, off a freshly fetched origin/<base>; `workspace`: the shared checkout. */
  source: z.enum(["origin", "workspace"]),
  /** The ref and commit the definition was read at (origin only). */
  ref: z.string().nullable().default(null),
  sha: z.string().nullable().default(null),
  /** Why the workspace checkout was used instead (workspace only). */
  note: z.string().nullable().default(null),
});
export type RunDefinition = z.infer<typeof RunDefinitionSchema>;

export const PlaybookSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  file: z.string(),
  inputs: z.record(z.string(), VarDefSchema),
  outputs: z.record(z.string(), PlaybookOutputSchema),
  concurrency: z.number().int().positive().optional(),
  /**
   * Set on a singleton playbook: one long-lived pipeline per project, in one shared workspace.
   * Its top-level steps are stations; its inputs, outputs and outcomes are each job's.
   */
  singleton: z
    .object({
      /** Branch its workspace branches off; unset = the project's default branch. */
      branch: z.string().optional(),
      /** Its stations, in file order (unset on runs from before pipelines). */
      stations: z.array(StationSchema).default([]),
    })
    .optional(),
  /**
   * How the playbook can end, as seen by a parent that uses it as a sub-playbook. The first is
   * a normal finish (all steps done, or a plain `end`); `{ end: <outcome> }` picks another.
   */
  outcomes: z.array(z.string()).default(["success"]),
  steps: z.array(StepSchema),
  roles: z.record(z.string(), RoleSchema),
  manager: AgentSettingsSchema,
  /** When the manager is compacted (`manager.compact`). Unset on runs from before it. */
  managerCompact: ManagerCompactSchema.default(DEFAULT_MANAGER_COMPACT),
  /** How long an exhausted `provider/model` is skipped before it is tried again (`providers.exhausted_for`), in ms. */
  exhaustedForMs: z.number().default(DEFAULT_EXHAUSTED_FOR_MS),
  /** Whether the plugin archives the workspace it created for a run once the run ends. */
  workspace: z
    .object({ archive: z.enum(["never", "on_end"]), keepFailed: z.boolean() })
    .default({ archive: "never", keepFailed: true }),
  /**
   * Where the run's agents work: the workspace checkout (`none`), or a private git worktree the
   * plugin creates for the run (`worktree`). Unset on runs from before isolation.
   */
  isolation: IsolationSchema.default(DEFAULT_ISOLATION),
  /**
   * Instructions added to the manager's protocol: `defaults/manager.md` (playbook null), then
   * this playbook's and each sub-playbook's `manager.prompt`, non-empty ones only, each once.
   * Unset on runs from before manager instructions.
   */
  managerInstructions: z.array(z.object({ playbook: z.string().nullable(), text: z.string() })).default([]),
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

/**
 * What an agent spent, summed over the turns it ended (each turn's `lastUsage` reading). `contextPeak`
 * is the largest context window seen at a turn end, not a sum. Absent on runs from before.
 */
export const UsageSchema = z.object({
  turns: z.number().int().min(0).default(0),
  inputTokens: z.number().min(0).default(0),
  cachedInputTokens: z.number().min(0).default(0),
  outputTokens: z.number().min(0).default(0),
  costUsd: z.number().min(0).default(0),
  contextPeak: z.number().min(0).default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

/** Adds one turn's usage reading to a running total. */
export function addUsage(
  total: Usage | null | undefined,
  reading: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalCostUsd?: number; contextWindowUsedTokens?: number },
): Usage {
  const base = total ?? UsageSchema.parse({});
  return {
    turns: base.turns + 1,
    inputTokens: base.inputTokens + (reading.inputTokens ?? 0),
    cachedInputTokens: base.cachedInputTokens + (reading.cachedInputTokens ?? 0),
    outputTokens: base.outputTokens + (reading.outputTokens ?? 0),
    costUsd: base.costUsd + (reading.totalCostUsd ?? 0),
    contextPeak: Math.max(base.contextPeak, reading.contextWindowUsedTokens ?? 0),
  };
}

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
  /** Hand-off steps: the job this attempt handed off, and the singleton run that holds it. */
  job: z.object({ runId: z.string(), jobId: z.string() }).nullable().default(null),
  /** Hand-off steps: the job passed every station, so a failure here is never retried (its work shipped). */
  noRetry: z.boolean().default(false),
  /** Agent steps: the `provider/model` the attempt's agent runs on, and the prompt it was started with (to restart it on the next target). */
  target: z.string().default(""),
  prompt: z.string().default(""),
  /** What the attempt's agent spent; null before its first turn ended, and on script and hand-off attempts. */
  usage: UsageSchema.nullable().optional(),
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
  /** How many times a goto has sent the run back through this step (0 on its first pass). Runs from before it start at 0. */
  loop: z.number().int().min(0).default(0),
  completedSeq: z.number().int().nullable(),
  /** Branch steps: the case that won (also the step's outcome); null before it ran. */
  branch: z.string().nullable().default(null),
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
  /** panel and chat: a human (chat = relayed by the manager); manager and role: a decider of the gate. */
  decidedVia: z.enum(["panel", "chat", "manager", "role"]).nullable(),
  /** Who may decide it besides a human in the panel; a human on gates opened before deciders. */
  decider: GateDeciderSchema.default({ by: "human" }),
  /** With a role decider: the agent deciding it, once started. */
  deciderAgentId: z.string().nullable().default(null),
  /** What the role decider's agent spent. */
  usage: UsageSchema.nullable().optional(),
  /** Set when the manager or role decider left the gate to a human: its reason. */
  escalated: z.string().nullable().default(null),
  /** When it was escalated. */
  escalatedAt: z.string().nullable().default(null),
  decidedAt: z.string().nullable(),
});
export type Gate = z.infer<typeof GateSchema>;

/** "boarding": runs from v0.30.0 only (removed); they are failed on load. */
export const RunStatusSchema = z.enum(["boarding", "running", "waiting_gate", "completed", "failed", "canceled"]);
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

/** Work a hand-off step gave a singleton pipeline: its inputs, where it is, and once ended its outcome and outputs. */
export const JobSchema = z.object({
  id: z.string(),
  /** The handing-off run and step, and the attempt that handed it off. */
  fromRunId: z.string(),
  fromStepId: z.string(),
  attempt: z.number().int().positive(),
  /** A short label for the panel, e.g. the handing-off run's playbook title. */
  label: z.string(),
  inputs: z.record(z.string(), VarValueSchema),
  /** open: waiting or being handled; settled: has an outcome; failed: its run failed or was canceled; withdrawn: its hand-off was canceled. */
  status: z.enum(["open", "settled", "failed", "withdrawn"]),
  outcome: z.string().nullable(),
  summary: z.string().nullable(),
  outputs: z.record(z.string(), VarValueSchema),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  /** Pipelines: the stations it has passed. */
  passed: z.array(z.string()).default([]),
  /** Pipelines: the stations it waits at, and since when (orders the waiting list). */
  waiting: z.array(z.object({ station: z.string(), since: z.string() })).default([]),
  /** Pipelines: the trains (runs) carrying it now, by station. */
  riding: z.array(z.object({ station: z.string(), runId: z.string(), since: z.string() })).default([]),
  /** Pipelines: failed trains it rode, by station (capped by the station's `retries`). */
  failedRides: z.record(z.string(), z.number().int()).default({}),
  /** Handed off with `wait: false`: the pipeline owns it; its run is never told of it and never withdraws it. */
  detached: z.boolean().default(false),
});
export type Job = z.infer<typeof JobSchema>;

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
  /** What the manager's agent spent while this run was its active one. */
  managerUsage: UsageSchema.nullable().optional(),
  /** The plugin created this run's workspace (`newWorkspace`), so it may archive it. Never set for a pipeline's or a moved run's. */
  workspaceCreated: z.boolean().default(false),
  /** Once the run ended: `done` (workspace archived) or `skipped` (kept; the history says why). */
  workspaceArchive: z.enum(["done", "skipped"]).nullable().default(null),
  /** `provider/model` targets that ran out of tokens in this run: later agents skip them for the next target of their chain. */
  exhausted: z.array(ExhaustedEntrySchema).default([]),
  /** The run's private git worktree (`isolation: worktree`); null when it works in the workspace checkout. */
  worktree: RunWorktreeSchema.nullable().default(null),
  /** Where the playbook definition came from (isolated runs); null on other runs and runs from before. */
  definition: RunDefinitionSchema.nullable().default(null),
  /** A short name the Playbook Manager gave the run (e.g. "login-redirect-fix"): its tab label. */
  name: z.string().nullable().default(null),
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
  /** Cumulative times each goto edge fired; `loops` is reset when an outer goto re-enters the block holding the edge. */
  loopTotals: z.record(z.string(), z.number().int()).default({}),
  gates: z.array(GateSchema),
  /** State of each after-task, by id. Runs created before after-tasks have none. */
  after: z.record(z.string(), RunAfterTaskSchema).default({}),
  inbox: z.array(z.string()),
  /** A pipeline: every job handed to it. A train: copies of the jobs it carries (its work). */
  jobs: z.array(JobSchema).default([]),
  /** Set on a train: the pipeline run and the station it runs for. */
  train: z.object({ pipelineId: z.string(), playbook: z.string(), station: z.string() }).nullable().default(null),
  history: z.array(HistoryEventSchema),
  seq: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

/** What the Playbooks screen needs of a step: its title, kind, dependencies and transitions, with no prompt, wiring or agent settings. */
export const StepSummarySchema = StepSchema.pick({
  id: true,
  title: true,
  shortTitle: true,
  kind: true,
  when: true,
  branch: true,
  needs: true,
  outcomes: true,
  on: true,
  choices: true,
  afterTask: true,
});
export type StepSummary = z.infer<typeof StepSummarySchema>;

/** The part of a playbook the Playbooks screen needs: its identity, stations, block titles and step summaries. */
export const PlaybookSummarySchema = PlaybookSchema.pick({ id: true, title: true, description: true, singleton: true, blocks: true }).extend({
  steps: z.array(StepSummarySchema),
});
export type PlaybookSummary = z.infer<typeof PlaybookSummarySchema>;

/**
 * A run as the Playbooks screen and the sidebar badge see it: the fields they draw rows, badges
 * and gate buttons from. No history, reports, outputs, attempts, inbox, step prompts or job
 * payloads: those make a run weigh megabytes. A whole run is `runs.list`.
 */
export const RunSummarySchema = z.object({
  id: z.string(),
  playbook: PlaybookSummarySchema,
  workspaceId: z.string(),
  projectId: z.string(),
  managerAgentId: z.string(),
  name: z.string().nullable(),
  /** The first line of the run's first text input (its request), cut short; null = none. */
  title: z.string().nullable(),
  status: RunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seenAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  steps: z.record(z.string(), z.object({ status: StepStatusSchema })),
  /** Open gates only (the decided ones are in the full run). */
  gates: z.array(GateSchema),
  /** After-tasks' statuses. */
  after: z.record(z.string(), z.object({ status: AfterTaskStatusSchema })),
  /** Jobs without their inputs and outputs: what the stations and the job counts show. */
  jobs: z.array(JobSchema.pick({ id: true, label: true, status: true, waiting: true })),
  train: RunSchema.shape.train,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

const TITLE_MAX = 200;

export function summarizeRun(run: Run): RunSummary {
  const text = Object.values(run.inputs).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const { id, title, description, singleton, blocks } = run.playbook;
  return {
    id: run.id,
    playbook: {
      id,
      title,
      description,
      singleton,
      blocks,
      steps: run.playbook.steps.map(({ id, title, shortTitle, kind, when, branch, needs, outcomes, on, choices, afterTask }) => ({
        id,
        title,
        shortTitle,
        kind,
        when,
        branch,
        needs,
        outcomes,
        on,
        choices,
        afterTask,
      })),
    },
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    managerAgentId: run.managerAgentId,
    name: run.name,
    title: text ? text.trim().split("\n")[0]!.slice(0, TITLE_MAX) : null,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    seenAt: run.seenAt,
    pausedAt: run.pausedAt,
    steps: Object.fromEntries(Object.entries(run.steps).map(([stepId, step]) => [stepId, { status: step.status }])),
    gates: run.gates.filter((gate) => gate.status === "pending"),
    after: Object.fromEntries(Object.entries(run.after).map(([taskId, task]) => [taskId, { status: task.status }])),
    jobs: run.jobs.map(({ id, label, status, waiting }) => ({ id, label, status, waiting })),
    train: run.train,
  };
}

/** Exit code a script step uses to say "not done yet, run me again after `poll`" (EX_TEMPFAIL). */
export const SCRIPT_NOT_YET = 75;

/** Script steps have no agent: their attempts carry this id instead, unique across runs. */
export function scriptAttemptId(runId: string, stepId: string, attempt: number): string {
  return `script:${runId}:${stepId}:${attempt}`;
}

export function isScriptAttempt(agentId: string): boolean {
  return agentId.startsWith("script:");
}

/** Hand-off steps have no agent either: their attempts carry this id. */
export function handoffAttemptId(runId: string, stepId: string, attempt: number): string {
  return `handoff:${runId}:${stepId}:${attempt}`;
}

export function isHandoffAttempt(agentId: string): boolean {
  return agentId.startsWith("handoff:");
}

/** An attempt run by the plugin itself (a script check or a hand-off), with no agent behind it. */
export function isAgentlessAttempt(agentId: string): boolean {
  return isScriptAttempt(agentId) || isHandoffAttempt(agentId);
}

/** A singleton's pipeline run: it keeps the waiting lists and jobs; its trains are other runs. */
export function isPipeline(run: { playbook: { singleton?: unknown }; train: unknown }): boolean {
  return run.playbook.singleton !== undefined && run.train === null;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "canceled"];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** After-tasks of the run that are running now ("wrapping up"). */
export function runningAfterTasks(run: { after: Record<string, { status: string }> }): string[] {
  return Object.entries(run.after).filter(([, task]) => task.status === "running").map(([id]) => id);
}

/**
 * Whether the run still has work going on: its main graph, or an after-task once it ended.
 * Use `isTerminal(run.status)` for the run's result, this for "can it still change".
 */
export function isActive(run: { status: RunStatus; after: Record<string, { status: string }> }): boolean {
  return !isTerminal(run.status) || runningAfterTasks(run).length > 0;
}

/** Paused by a human and still active. A pause left on a run that has since ended means nothing. */
export function isPaused(run: { status: RunStatus; after: Record<string, { status: string }>; pausedAt: string | null }): boolean {
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
