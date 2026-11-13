import { z } from "zod";
import { stepTiming } from "./slow";

/** Plain values that inputs and outputs carry. */
export const VarValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type VarValue = z.infer<typeof VarValueSchema>;

/**
 * `list`: a JSON array of scalars or flat objects, kept as its JSON text (so values stay plain strings in run
 * state). See `parseList` in vars.ts for the bounds.
 */
export const VarTypeSchema = z.enum(["string", "number", "boolean", "enum", "list"]);
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
/**
 * Whether a run has a Playbook Manager: `always_on` (default) is one agent that drives the run from start to end;
 * `none` has no manager agent: the plugin starts steps, applies reports, opens gates and stops the run on failure.
 */
export const ManagerModeSchema = z.enum(["always_on", "none"]);
export type ManagerMode = z.infer<typeof ManagerModeSchema>;
/** Used when neither the playbook nor `defaults/main.yaml` sets `manager.mode`. */
export const DEFAULT_MANAGER_MODE: ManagerMode = "always_on";

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

/** Events that wake a script step or a stage's admission check at once (`wake_on`): a rule matches a type and equal payload fields. */
export const WakeOnSchema = z.array(z.object({ types: z.array(z.string()).min(1), filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }));
export type WakeOn = z.infer<typeof WakeOnSchema>;

export const StepSchema = z.object({
  id: z.string(),
  /** Full name (details panel, graph). Unset = stepLabel(id). */
  title: z.string().optional(),
  /** Name in the Playbooks screen columns. Unset = the title. */
  shortTitle: z.string().optional(),
  /** For people only (step sheet, graph info, get_run): why and how the step exists. Never in an agent's prompt or brief. */
  description: z.string().optional(),
  kind: z.enum(["agent", "gate", "script", "handoff", "branch", "fanout"]),
  role: z.string().optional(),
  gate: z.string().optional(),
  /** Script steps: the executable, relative to the workspace (`<playbooks folder>/scripts/<name>`). */
  script: z.string().optional(),
  /** Hand-off steps: the singleton playbook the step hands a job to. */
  handoff: z.string().optional(),
  /** Runs the step only when every condition holds; otherwise it is skipped. Unset = always. */
  when: z.array(WhenSchema).optional(),
  /**
   * Branch steps: ordered cases, the first whose conditions hold wins (a case without `when` is the
   * `else`, always last). The step completes at once with the winning case as its outcome.
   */
  branch: z.object({ cases: z.array(z.object({ name: z.string(), when: z.array(WhenSchema).optional(), end: z.object({ outcome: z.string().optional() }).optional() })) }).optional(),
  /** Fan-out steps: the playbook started once per item, and how (templates over `inputs.<name>`, `item`, `index`). */
  fanout: z
    .object({
      /** The playbook (qualified id) each item starts a run of, in its own new workspace. */
      playbook: z.string(),
      /** Renders to the list (JSON array); one run per element. */
      items: z.string(),
      /** The child's inputs, by name. */
      inputs: z.record(z.string(), z.string()),
      /** Per-item stable key: a child run is never started twice for one key. Unset = the item itself (scalars only). */
      key: z.string().optional(),
      /** Per-item title of the child's workspace. Unset = the child's default title. */
      workspaceName: z.string().optional(),
      /** At most this many child runs active at once. */
      maxActive: z.number().int().positive(),
      /** Cancel the still-active child runs when the parent run is canceled or fails, or the step is reset. */
      cancelChildren: z.boolean(),
    })
    .optional(),
  /** On a batch of a singleton pipeline: the plugin settles its jobs from this output when the step completes. `effects`: per outcome, what happens to the job (an outcome not listed ends it). */
  settle: z.object({ output: z.string(), effects: z.record(z.string(), z.enum(["continue", "requeue"])).default({}) }).optional(),
  /** Script steps: rerun the script this often while it exits with SCRIPT_NOT_YET. Unset = run it once. */
  pollMs: z.number().int().positive().optional(),
  /** Script steps: events that run a check at once instead of waiting for the next poll (`poll` stays the safety net). */
  wakeOn: WakeOnSchema.optional(),
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
  /** Agent steps: `false` (`manage.auto_start: false`) keeps the step `ready` until the manager starts it with a brief. Unset = the plugin starts it. */
  autoStart: z.boolean().optional(),
  /** `true` (`manage.notify`): the step's normal completion wakes the manager. Unset = only failures, gates and judgment calls do. */
  notify: z.boolean().optional(),
  /** Agent steps: outcomes the plugin applies itself when the agent reports them (`role.completion.auto`). Unset = the manager applies every outcome. */
  autoComplete: z.array(z.string()).optional(),
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

/** A top-level step of a singleton: a waiting list of jobs, and one batch at a time. */
export const StageSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Stages a job must have passed before it waits here. */
  needs: z.array(z.string()),
  /** fifo: one job per batch, oldest first; merge: every waiting job per batch. */
  mode: z.enum(["fifo", "merge"]),
  /** Failed batches a job may be retried here before it fails. */
  retries: z.number().int().min(0),
  /** `queue.max_requeues`: how often an outcome declared `requeue` may put one job back here before it fails. Unset = no cap. */
  maxRequeues: z.number().int().min(0).optional(),
  /** What the outcomes of the stage's `settle` steps do to a job: `continue` (it goes on in the batch) or `requeue` (back to this queue). An outcome not listed ends the job. */
  effects: z.record(z.string(), z.enum(["continue", "requeue"])).default({}),
  /** Its steps in `Playbook.steps` (one, or the expanded steps of its sub-playbook). */
  steps: z.array(z.string()),
  /**
   * `queue.admit`: a script the plugin runs on the waiting list (no batch, no agent) that says which waiting jobs may join.
   * Unset = every waiting job may join (ADR 2026-11-12-queue-admission-impl).
   */
  admit: z
    .object({
      /** The script, relative to the workspace root (`<folder>/scripts/<name>`). */
      script: z.string(),
      /** Safety-net interval between checks. */
      pollMs: z.number().int().positive(),
      /** Events that run a check at once; a job queued at this stage always does (not listed here). */
      wakeOn: WakeOnSchema.default([]),
    })
    .optional(),
});
export type Stage = z.infer<typeof StageSchema>;

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
   * Its top-level steps are stages; its inputs, outputs and outcomes are each job's.
   */
  singleton: z
    .object({
      /** Branch its workspace branches off; unset = the project's default branch. */
      branch: z.string().optional(),
      /** Its stages, in file order (unset on runs from before pipelines). */
      stages: z.array(StageSchema).default([]),
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
  /** `manager.mode`: `none` = no manager agent, the plugin drives the run. Unset on runs from before it (= always_on). */
  managerMode: ManagerModeSchema.default(DEFAULT_MANAGER_MODE),
  /** How long an exhausted `provider/model` is skipped before it is tried again (`providers.exhausted_for`), in ms. */
  exhaustedForMs: z.number().default(DEFAULT_EXHAUSTED_FOR_MS),
  /** What a step does when every provider of its role is out of tokens (`providers.on_exhausted`). */
  onExhausted: z.enum(["fail", "wait"]).default("fail"),
  /** How long a step waits at most for a provider to recover (`providers.max_wait`), in ms; null = no limit. */
  maxWaitMs: z.number().nullable().default(null),
  /** `provider/model` targets every step agent falls back to, after its own chain (`providers.fallback`). */
  fallback: z.array(z.string()).default([]),
  /** Whether a target whose provider's usage is at the threshold is skipped before it is used (`providers.usage.check`). */
  usageCheck: z.boolean().default(true),
  /** The percentage of a usage window at which a target is skipped (`providers.usage.threshold`). */
  usageThreshold: z.number().default(100),
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
  /** `slow_warning`: how the slow-step warning is computed (ADR 2026-11-12-slow-step-warning). */
  slowWarning: z.object({ runs: z.number().int().min(3), factor: z.number().gt(1) }).default({ runs: 10, factor: 2 }),
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
export const ProfileInfoSchema = z.object({
  /** The folder name in `profiles/`, or `default` for the main repository (listed first in a project's offer). */
  id: z.string(),
  /** Turned on in the user config: its playbooks are in the catalog. `default` is on unless the project turned it off. */
  active: z.boolean(),
  /** Playbook files in the profile's folder. */
  playbooks: z.number(),
  errors: z.array(z.string()).default([]),
});
export type ProfileInfo = z.infer<typeof ProfileInfoSchema>;

export const PlaybookEntrySchema = z.object({
  /** `deploy` in the default repository, `louis:deploy` in the profile `louis`. */
  id: z.string(),
  /** The repository it comes from: `default` or a profile id. */
  repo: z.string().default("default"),
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
 * What an agent spent, summed over the turns it ended (the change in `lastUsage` since the previous turn, which is cumulative). `contextPeak`
 * is the largest context window seen at a turn end, not a sum. Absent on runs from before.
 */
export const UsageSchema = z.object({
  turns: z.number().int().min(0).default(0),
  inputTokens: z.number().min(0).default(0),
  cachedInputTokens: z.number().min(0).default(0),
  outputTokens: z.number().min(0).default(0),
  contextPeak: z.number().min(0).default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

/** What the daemon reports as an agent's `lastUsage`: cumulative for the session (the token counts, on some providers). */
export interface UsageReading {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
}

/**
 * What an agent spent since its previous reading. The readings are cumulative, so each counter is the
 * difference; a counter that went down (the session was restarted or compacted) starts over from its
 * new value. Without a previous reading the whole reading counts. The context size is a gauge, kept as is.
 */
export function usageDelta(previous: UsageReading | null | undefined, reading: UsageReading): UsageReading {
  const step = (now: number | undefined, before: number | undefined): number => {
    const value = now ?? 0;
    const base = before ?? 0;
    return value >= base ? value - base : value;
  };
  return {
    inputTokens: step(reading.inputTokens, previous?.inputTokens),
    cachedInputTokens: step(reading.cachedInputTokens, previous?.cachedInputTokens),
    outputTokens: step(reading.outputTokens, previous?.outputTokens),
    contextWindowUsedTokens: reading.contextWindowUsedTokens ?? 0,
  };
}

/** Adds one turn's usage (a `usageDelta`, not the raw cumulative reading) to a running total. */
export function addUsage(
  total: Usage | null | undefined,
  reading: UsageReading,
): Usage {
  const base = total ?? UsageSchema.parse({});
  return {
    turns: base.turns + 1,
    inputTokens: base.inputTokens + (reading.inputTokens ?? 0),
    cachedInputTokens: base.cachedInputTokens + (reading.cachedInputTokens ?? 0),
    outputTokens: base.outputTokens + (reading.outputTokens ?? 0),
    contextPeak: Math.max(base.contextPeak, reading.contextWindowUsedTokens ?? 0),
  };
}

/** One agent of an attempt: its id, the `provider/model` it ran on, when it started and why it got that target. */
export const AttemptAgentSchema = z.object({
  agentId: z.string(),
  target: z.string(),
  at: z.string(),
  why: z.enum(["chain", "model", "failover", "resumed"]),
});

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
  /** Hand-off steps: the job passed every stage, so a failure here is never retried (its work shipped). */
  noRetry: z.boolean().default(false),
  /** Agent steps: the `provider/model` the attempt's agent runs on, and the prompt it was started with (to restart it on the next target). */
  target: z.string().default(""),
  prompt: z.string().default(""),
  /** Agent steps with `providers.on_exhausted: wait`: set while every provider of the role is out of tokens; the attempt restarts at `until`. */
  waiting: z.object({ since: z.string(), until: z.string() }).nullable().default(null),
  /**
   * Agent steps: every agent the attempt ran on, oldest first, and why it got that target: `chain` (the
   * role's first available target), `model` (the manager's `model` on start_step, nudge_step or
   * restart_run), `failover` (the previous one ran out of tokens) or `resumed` (after waiting for tokens).
   * Empty on attempts from before it.
   */
  agents: z.array(AttemptAgentSchema).default([]),
  /** What the attempt's agent spent; null before its first turn ended, and on script and hand-off attempts. */
  usage: UsageSchema.nullable().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;
export type AttemptAgent = z.infer<typeof AttemptAgentSchema>;

/** How a fan-out child ended, as the join reports it. */
export const FanoutOutcomeSchema = z.enum(["completed", "failed", "canceled", "not_started"]);
export type FanoutOutcome = z.infer<typeof FanoutOutcomeSchema>;

/** One item of a fan-out: its stable key, the child run started for it and where that stands. */
export const FanoutChildSchema = z.object({
  key: z.string(),
  index: z.number().int().min(0),
  /** The item as JSON text. */
  item: z.string(),
  /** Rendered inputs of the child run (set once the child is about to start). */
  inputs: z.record(z.string(), VarValueSchema).default({}),
  workspaceName: z.string().default(""),
  /**
   * pending: not started (waits for a free slot); starting: its workspace and manager are being created, the run does not exist yet;
   * running: its run is active; completed, failed, canceled: its run ended so; not_started: it could not be started (see `error`).
   */
  status: z.enum(["pending", "starting", "running", "completed", "failed", "canceled", "not_started"]),
  runId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  /** The child run's outputs, once it completed. */
  outputs: z.record(z.string(), VarValueSchema).default({}),
});
export type FanoutChild = z.infer<typeof FanoutChildSchema>;

export const FanoutStateSchema = z.object({
  /** The attempt these children belong to. */
  attempt: z.number().int().positive(),
  /** The step's loop count (the pass of the parent's loop) when it started. */
  loop: z.number().int().min(0).default(0),
  startedAt: z.string().default(""),
  children: z.array(FanoutChildSchema),
});
export type FanoutState = z.infer<typeof FanoutStateSchema>;

export const MAX_FANOUT_PAST = 20;

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
  /** Fan-out steps: the child runs of the current attempt (null before it started). */
  fanout: FanoutStateSchema.nullable().default(null),
  /** Fan-out steps: the children of earlier passes and attempts, oldest first (the last MAX_FANOUT_PAST kept). */
  fanoutPast: z.array(FanoutStateSchema).default([]),
  /** When the step started waiting for a free `concurrency` slot of its block (orders the queue). */
  queuedAt: z.string().nullable().default(null),
  /** The `model` restart_run gave for this step: its next attempt runs on it unless start_step passes its own. Null when none. */
  nextModel: z.object({ target: z.string(), thinking: z.string().optional() }).nullable().default(null),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const GateSchema = z.object({
  id: z.string(),
  kind: z.enum(["gate", "loop_limit", "ask", "admission"]),
  /** An `admission` gate: the stage it is about (its `stepId`) and the held job it asks about. Null on the other kinds. */
  jobId: z.string().nullable().default(null),
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
  /** A run with no manager: the step agent the plugin asked to put this gate's question to the human in its own conversation. */
  chatAgentId: z.string().nullable().optional(),
  /** Set once the gate is closed and that conversation was told (its open question dismissed when the panel decided). */
  chatClosed: z.boolean().optional(),
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
  /** Pipelines: the stages it has passed. */
  passed: z.array(z.string()).default([]),
  /** Pipelines: the stages it waits at, and since when (orders the waiting list). */
  waiting: z
    .array(
      z.object({
        stage: z.string(),
        since: z.string(),
        /**
         * Admission (`queue.admit`): why the job may not join now, and when that was decided; `checkedAt` null = the
         * first check has not run yet. Null = it may join. Never set at a stage without `admit`.
         */
        held: z.object({ reason: z.string(), checkedAt: z.string().nullable() }).nullable().default(null),
        /** A human admitted it anyway: the script no longer holds it, and it leaves this list when it joins. */
        forced: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Pipelines: the batches (runs) carrying it now, by stage. */
  batches: z.array(z.object({ stage: z.string(), runId: z.string(), since: z.string() })).default([]),
  /** Pipelines: failed batches it rode, by stage (capped by the stage's `retries`). */
  failedRides: z.record(z.string(), z.number().int()).default({}),
  /** The pipeline owns it: its run is never told of it and never withdraws it. Always true for a hand-off; false only on jobs of run files from before ADR 2026-11-12-handoff-gives-the-task-away. */
  detached: z.boolean().default(false),
  /**
   * Put back at its stage's queue by an outcome the playbook declares `requeue` (ADR 2026-11-12-requeue-outcome-effects): the outcome, the
   * reason and the blocker are the batch's own opaque strings. Cleared when a batch takes the job again.
   */
  requeued: z.object({ stage: z.string(), outcome: z.string(), reason: z.string(), blocker: z.string().nullable(), at: z.string() }).nullable().default(null),
  /** Pipelines: how many times an outcome requeued it, by stage (capped by the stage's `queue.max_requeues`). */
  requeues: z.record(z.string(), z.number().int()).default({}),
  /**
   * What the batch's manager did after the job ended with a non-first outcome while detached (nobody was told): a follow-up run
   * it started (`runId`) or an explicit "none needed" (`runId` null, with a `note`). Empty = the hand-off is still pending
   * (ADR 2026-11-12-pending-follow-ups).
   */
  followUps: z.array(z.object({ runId: z.string().nullable(), note: z.string().nullable(), by: z.string().nullable(), at: z.string() })).default([]),
});
export type Job = z.infer<typeof JobSchema>;

export const HistoryEventSchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  stepId: z.string().nullable(),
  detail: z.string(),
});

/** What a script step's checks print: the running check's live tail and the last ended checks (memory only; empty after a daemon restart). */
export const ScriptOutputSchema = z.object({
  /** A check is running now. */
  running: z.boolean(),
  /** When the running check started. */
  since: z.string().nullable(),
  /** The running check's latest output, bounded. */
  tail: z.string(),
  /** What started the running check (see `checks[].trigger`); null between checks. */
  trigger: z.string().nullable().optional(),
  /** Ended checks, oldest first, each with its own bounded tail. */
  checks: z.array(
    z.object({
      n: z.number().int(),
      startedAt: z.string(),
      endedAt: z.string(),
      /** "not_yet" (the script asked to be run again), or the reported outcome. */
      outcome: z.string(),
      exitCode: z.number().int().nullable(),
      tail: z.string(),
      /** What started the check: "first" run, the "poll" timer, or an event ("woken by job.settled"). Default "poll" for older readers. */
      trigger: z.string().default("poll"),
    }),
  ),
});
export type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

/** A stage's admission check (`queue.admit`), live in memory: running or waiting, the last outcome and the last failure. */
export const AdmissionStatusSchema = z.object({
  /** A check is running now. */
  running: z.boolean(),
  /** When the running check started. */
  since: z.string().nullable(),
  /** What started the running check: "first", "poll", "event:<type>", "retry". */
  trigger: z.string().nullable(),
  /** The running check's latest output, bounded. */
  tail: z.string(),
  /** When the next check is due (poll timer or a wake-up waiting out the gap); null while one runs or nothing waits. */
  nextCheckAt: z.string().nullable(),
  /** Checks that ended since the plugin started tracking this stage. */
  checks: z.number().int(),
  lastCheckAt: z.string().nullable(),
  lastOutcome: z.enum(["ok", "not_yet", "failed"]).nullable(),
  /** The last check failed (exit, timeout, no result line): when, why and the end of its output. Cleared by the next check that ends well. */
  error: z.object({ at: z.string(), message: z.string(), tail: z.string() }).nullable(),
  /** The last good check's remarks (unknown job ids in its result). */
  warnings: z.array(z.string()),
});
export type AdmissionStatus = z.infer<typeof AdmissionStatusSchema>;

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
  /** Usage is recorded as per-turn deltas (v0.66.1+). Runs without it hold a cumulative-summed, inflated `managerUsage`, which analytics ignores. */
  usageDeltas: z.boolean().default(false),
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
  /** Ready agent steps the plugin must not start by itself (`start_playbook` with `autoStart: false`): the manager starts them. Dropped once started. */
  held: z.array(z.string()).default([]),
  /** Set on a run a fan-out step started: the parent run, its step and the item's key. */
  parent: z.object({ runId: z.string(), stepId: z.string(), key: z.string() }).nullable().default(null),
  /** A pipeline: every job handed to it. A batch: copies of the jobs it carries (its work). */
  jobs: z.array(JobSchema).default([]),
  /** Set on a batch: the pipeline run and the stage it runs for. */
  batch: z.object({ pipelineId: z.string(), playbook: z.string(), stage: z.string() }).nullable().default(null),
  history: z.array(HistoryEventSchema),
  seq: z.number().int(),
  /** The last event-log entry (`<run>.events.jsonl`) this snapshot includes; 0 before the run has a log (ADR 2026-11-12-event-core). */
  eventSeq: z.number().int().default(0),
});
export type Run = z.infer<typeof RunSchema>;

/** What the Playbooks screen needs of a step: its title, kind, dependencies and transitions, with no prompt, wiring or agent settings. */
export const StepSummarySchema = StepSchema.pick({
  id: true,
  title: true,
  shortTitle: true,
  description: true,
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

/** The part of a playbook the Playbooks screen needs: its identity, stages, block titles and step summaries. */
export const PlaybookSummarySchema = PlaybookSchema.pick({ id: true, title: true, description: true, singleton: true, blocks: true, slowWarning: true }).extend({
  /** A singleton's outcomes (the first is the normal finish): what tells a job whose hand-off is pending. */
  outcomes: z.array(z.string()).default([]),
  steps: z.array(StepSummarySchema),
});
export type PlaybookSummary = z.infer<typeof PlaybookSummarySchema>;

/** A fan-out child as the Playbooks screen draws a lane: its key, its run (null until created) and where it stands. */
export const FanoutChildSummarySchema = z.object({ key: z.string(), runId: z.string().nullable(), status: FanoutChildSchema.shape.status, error: z.string().nullable().default(null) });
export const FanoutPassSummarySchema = z.object({ loop: z.number().int(), children: z.array(FanoutChildSummarySchema) });
/** Earlier passes the summary carries per fan-out step. */
export const SUMMARY_FANOUT_PASSES = 5;

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
  /** Each step's status, and when its work started and ended (for the slow-step warning). */
  steps: z.record(z.string(), z.object({ status: StepStatusSchema, startedAt: z.string().nullable().default(null), endedAt: z.string().nullable().default(null) })),
  /** Open gates only (the decided ones are in the full run). */
  gates: z.array(GateSchema),
  /** After-tasks' statuses. */
  after: z.record(z.string(), z.object({ status: AfterTaskStatusSchema })),
  /** Jobs without their inputs and outputs: what the stages and the job counts show. */
  jobs: z.array(JobSchema.pick({ id: true, label: true, status: true, waiting: true, requeued: true, detached: true, outcome: true, followUps: true })),
  batch: RunSchema.shape.batch,
  /** Set on a run a fan-out step started: its parent run, step and the item's key. */
  parent: RunSchema.shape.parent.default(null),
  /** Fan-out steps that started: the current pass's children, and the last passes before it (oldest first), by step id. */
  fanouts: z.record(z.string(), z.object({ loop: z.number().int(), children: z.array(FanoutChildSummarySchema), past: z.array(FanoutPassSummarySchema) })).default({}),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

const TITLE_MAX = 200;

export function summarizeRun(run: Run): RunSummary {
  const text = Object.values(run.inputs).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const { id, title, description, singleton, blocks, slowWarning, outcomes } = run.playbook;
  return {
    id: run.id,
    playbook: {
      id,
      outcomes,
      title,
      description,
      singleton,
      blocks,
      slowWarning,
      steps: run.playbook.steps.map(({ id, title, shortTitle, description, kind, when, branch, needs, outcomes, on, choices, afterTask }) => ({
        id,
        title,
        shortTitle,
        description,
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
    steps: Object.fromEntries(Object.entries(run.steps).map(([stepId, step]) => [stepId, { status: step.status, ...stepTiming(step) }])),
    gates: run.gates.filter((gate) => gate.status === "pending"),
    after: Object.fromEntries(Object.entries(run.after).map(([taskId, task]) => [taskId, { status: task.status }])),
    jobs: run.jobs.map(({ id, label, status, waiting, requeued, detached, outcome, followUps }) => ({ id, label, status, waiting, requeued, detached, outcome, followUps })),
    batch: run.batch,
    parent: run.parent,
    fanouts: Object.fromEntries(
      Object.entries(run.steps).flatMap(([stepId, step]) =>
        step.fanout && step.status !== "pending" && step.status !== "ready"
          ? [[stepId, { loop: step.fanout.loop, children: summarizeChildren(step.fanout), past: step.fanoutPast.slice(-SUMMARY_FANOUT_PASSES).map((pass) => ({ loop: pass.loop, children: summarizeChildren(pass) })) }]]
          : [],
      ),
    ),
  };
}

function summarizeChildren(state: FanoutState): Array<z.infer<typeof FanoutChildSummarySchema>> {
  return state.children.map((child) => ({ key: child.key, runId: child.runId, status: child.status, error: child.error }));
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

/** Fan-out steps have no agent either: their attempts carry this id. */
export function fanoutAttemptId(runId: string, stepId: string, attempt: number): string {
  return `fanout:${runId}:${stepId}:${attempt}`;
}

export function isFanoutAttempt(agentId: string): boolean {
  return agentId.startsWith("fanout:");
}

/** An attempt run by the plugin itself (a script check, a hand-off or a fan-out), with no agent behind it. */
export function isAgentlessAttempt(agentId: string): boolean {
  return isScriptAttempt(agentId) || isHandoffAttempt(agentId) || isFanoutAttempt(agentId);
}

/** A singleton's pipeline run: it keeps the waiting lists and jobs; its batches are other runs. */
/** A run with no Playbook Manager (`manager: { mode: none }`): the plugin drives it. */
export function isManagerless(run: { playbook: { managerMode?: string | undefined; singleton?: unknown }; batch?: unknown }): boolean {
  return run.playbook.managerMode === "none" && !run.playbook.singleton && !run.batch;
}

export function isPipeline(run: { playbook: { singleton?: unknown }; batch: unknown }): boolean {
  return run.playbook.singleton !== undefined && run.batch === null;
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
