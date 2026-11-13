import { access, constants, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_GATE_CHOICES } from "../shared/gates";
import { ancestorsOf, findCycle } from "../shared/graph";
import { stepLabel } from "../shared/labels";
import { DEFAULT_SLOW_WARNING } from "../shared/slow";
import type {
  AskChoice,
  GateChoice,
  GateDecider,
  AgentSettings,
  ManagerCompact,
  InputWiring,
  Playbook,
  PlaybookEntry,
  ProfileInfo,
  Role,
  Step,
  Transition,
  VarDef,
  VarType,
  Stage,
  VarValue,
  When,
} from "../shared/types";
import { AgentSettingsSchema, DEFAULT_EXHAUSTED_FOR_MS, DEFAULT_MANAGER_COMPACT, DEFAULT_MANAGER_MODE, ManagerCompactSchema, ManagerModeSchema, type ManagerMode, type Isolation, type WakeOn, VarTypeSchema, VarValueSchema } from "../shared/types";
import { BusError, checkTypes, FilterValueSchema } from "./bus";
import { JOB_TYPES } from "./job-events";
import { OVERSIGHT_TYPES } from "./oversight-events";
import { readProjectDefault, readProjectProfiles } from "./config";
import { bareId, DEFAULT_REPO, qualified } from "../shared/repos";
import { coerceValue, parseDuration, replaceRefs, singleRef, templateRefs, typeCompatible } from "../shared/vars";

/** Folders searched for playbooks, relative to the workspace. Each folder is self-contained. */
export const PLAYBOOKS_DIRS = [".paseo/plugins/playbooks", ".paseo/playbooks"] as const;
const ID = /^[a-z][a-z0-9_-]*$/;
// "outputs" would make steps.<id>.outputs.<name> ambiguous once sub-playbook ids contain dots.
const RESERVED_STEP_IDS = new Set(["end", "fail", "outputs"]);
const AGENT_OUTCOMES = ["success", "failure"];
const GATE_OUTCOMES = DEFAULT_GATE_CHOICES.map((choice) => choice.id);

// ------------------------------------------------------------------ raw YAML

const RawVarDefSchema = z.object({
    type: VarTypeSchema.default("string"),
    values: z.array(z.string()).optional(),
    required: z.boolean().optional(),
    default: VarValueSchema.optional(),
    description: z.string().optional(),
  });

const RawOutputSchema = RawVarDefSchema.extend({ value: z.string().optional() });

const RawScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** Agent settings as written in YAML: `tier` names an entry of the defaults' `tiers`, which the other fields override. */
const RawAgentSchema = AgentSettingsSchema.extend({ tier: z.string().min(1).optional() });
type RawAgent = z.infer<typeof RawAgentSchema>;

/** A named bundle of agent settings in `defaults/main.yaml`. */
const RawTierEntrySchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    mode: z.string().optional(),
    thinking: z.string().optional(),
  })
  .strict();
/** One target, or an ordered list of targets: the next is used when the previous one is out of tokens. */
const RawTierSchema = z.union([RawTierEntrySchema, z.array(RawTierEntrySchema).min(1)]);

/** Who decides a gate besides a human in the panel; absent = a human. */
const RawDeciderSchema = z
  .object({
    by: z.enum(["human", "manager", "role"]),
    /** With `by: role`: a readonly role of the folder's roles/. */
    role: z.string().optional(),
    /** With `by: role`: agent settings of the deciding agent, over the role's. */
    agent: RawAgentSchema.optional(),
  })
  .strict();
type RawDecider = z.infer<typeof RawDeciderSchema>;

const RawTransitionSchema = z.union([
  z.enum(["complete", "end", "fail"]),
  /** `end` with one of the playbook's `outcomes`: what a sub-playbook reports to its parent step's `on`. */
  z.object({ end: z.string() }),
  /**
   * Ask a human (gate with a required comment), then go back to `goto` (default: this step) with
   * the answer. `choices` gives the gate several buttons, each with its own `goto` (default: the
   * ask's) and comment rule (default: required); the comment becomes the target's feedback.
   * A choice with `outcome` ends the step with that outcome and `outputs` instead.
   */
  z.object({
    ask: z.string().min(1),
    goto: z.string().optional(),
    max_loops: z.number().int().positive().optional(),
    choices: z
      .record(
        z.string(),
        z
          .object({
            goto: z.string().optional(),
            max_loops: z.number().int().positive().optional(),
            /** Ends the step with this outcome (its `on` entry) instead of a `goto`: the step does not run again. */
            outcome: z.string().optional(),
            /** With `outcome`: outputs set on the step, templates over gate.*, report.* and inputs.*. */
            outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional(),
            label: z.string().optional(),
            comment: z.enum(["none", "optional", "required"]).default("required"),
            color: z.enum(["primary", "neutral", "success", "warning", "danger"]).optional(),
          })
          .nullable(),
      )
      .optional(),
    /** Who answers the ask (and the loop-limit gates of its choices). */
    decider: RawDeciderSchema.optional(),
  }),
  /** `decider`: who decides the loop-limit gate `max_loops` opens. */
  z.object({
    goto: z.string(),
    max_loops: z.number().int().positive().optional(),
    decider: RawDeciderSchema.optional(),
    /** How long after the outcome the target starts, such as `2m` (parsed like `timeout`). Unset = at once. */
    delay: z.string().optional(),
  }),
]);

/**
 * A step kind's block. A plain string (the form before blocks) passes through as a string so
 * the loader can refuse it with what to write instead; anything else must match the block.
 */
function kindBlock<T extends z.ZodType>(block: T) {
  return z.unknown().transform((value, ctx): string | z.output<T> => {
    if (typeof value === "string") return value;
    const parsed = block.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue } as Parameters<typeof ctx.addIssue>[0]);
    return z.NEVER;
  });
}

/** How the Playbook Manager is involved in a step: whether the plugin starts it, whether its completion wakes the manager. */
const RawManageSchema = z
  .object({
    /** Agent steps: `false` leaves the step `ready` when it becomes ready, so the manager starts it with `start_step` and a brief. Default true (the plugin starts it with an empty brief). */
    auto_start: z.boolean().optional(),
    /** `true` wakes the manager when the step completes normally (it is told the outcome and what follows). Default false: only failures, gates and judgment calls wake it. */
    notify: z.boolean().optional(),
  })
  .strict();

/** An agent step: the role and the options that only apply to its agent. */
const RawRoleStepSchema = z
  .object({
    /** A role in the folder's roles/. */
    name: z.string().min(1),
    prompt: z.string().optional(),
    /** Remind the agent after this long without activity (`30m`), or `off`. */
    silence: z.string().optional(),
    /** Archive the step's agents once it completes or its flow ends, and each attempt's once the next starts. Default true. */
    archive_agents: z.boolean().optional(),
    agent: RawAgentSchema.optional(),
    /** How the step's reported outcome is applied. */
    completion: z
      .object({
        /** Outcomes (ids of the step's `outcomes`) the plugin applies itself when the agent reports them, without waking the manager. */
        auto: z.array(z.string()).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A human gate: the question and its buttons. */
const RawGateStepSchema = z
  .object({
    question: z.string().min(1),
    /** The buttons, in order. Keys are the outcomes; the first one continues by default. */
    choices: z
      .record(
        z.string(),
        z
          .object({
            label: z.string().optional(),
            comment: z.enum(["none", "optional", "required"]).default("none"),
            color: z.enum(["primary", "neutral", "success", "warning", "danger"]).optional(),
          })
          .nullable(),
      )
      .optional(),
    /** Who decides the gate besides a human in the panel. */
    decider: RawDeciderSchema.optional(),
  })
  .strict();

/** The event types a script's `wake_on` can name: those the runtime registers on its bus. */
const WAKE_TYPES = [...OVERSIGHT_TYPES, ...JOB_TYPES];

/** Rules of a `wake_on`: a check runs at once when an event of one of the types, with these payload fields, is emitted. */
const RawWakeOnSchema = z
  .array(
    z
      .object({
        /** Event types: exact (`job.settled`) or globs (`job.*`), as `subscribe_events` takes them. */
        types: z.array(z.string()).min(1),
        /** Payload fields that must equal these values (declared fields of the chosen types). */
        filter: z.record(z.string(), FilterValueSchema).default({}),
      })
      .strict(),
  )
  .min(1);

/** Validates the rules of a `wake_on` against the bus's event types; reports each refused rule with `err`. */
function checkWakeOn(rules: z.infer<typeof RawWakeOnSchema>, where: string, err: (message: string) => void): WakeOn {
  const checked: WakeOn = [];
  rules.forEach((wake, index) => {
    try {
      if ("olderThanMinutes" in wake.filter) throw new BusError("filter \"olderThanMinutes\" is only for subscribe_events");
      checkTypes(WAKE_TYPES, wake.types, wake.filter, false);
      checked.push({ types: [...new Set(wake.types)], filter: wake.filter });
    } catch (error) {
      if (!(error instanceof BusError)) throw error;
      err(`${where}[${index}]: ${error.message}`);
    }
  });
  return checked;
}

/** A script step: an executable in the folder's scripts/, run by the plugin itself. */
const RawScriptStepSchema = z
  .object({
    run: z.string().min(1),
    /** Rerun the script this often while it exits with SCRIPT_NOT_YET (`30s`, `1m`). */
    poll: z.string().optional(),
    /** Run a check at once when a matching bus event is emitted, instead of waiting for the next poll. Needs `poll` (the safety net). */
    wake_on: RawWakeOnSchema.optional(),
  })
  .strict();

/** A sub-playbook from the same folder, run in place of this step. */
const RawPlaybookStepSchema = z.object({ name: z.string().min(1) }).strict();

/** A hand-off: gives a job to a singleton playbook from the same folder; the step is done once the pipeline takes it. */
const RawHandoffStepSchema = z
  .object({
    name: z.string().min(1),
    /** Removed (a hand-off never waits): read only to refuse it with what to write instead. */
    wait: z.unknown().optional(),
  })
  .strict();

/** A fan-out: one run of a playbook from the same folder per item of a list, each in its own new workspace; the step joins them. */
const RawFanoutStepSchema = z
  .object({
    /** The playbook started once per item (not this one, not a singleton). */
    playbook: z.string().min(1),
    /** Renders to the list: a JSON array. Write `{{ inputs.<name> }}` of a declared step input (an output of an earlier step of type `list`). */
    items: z.string().min(1),
    /** The child's inputs. Templates over `item` (`{{ item }}`, `{{ item.<field> }}`), `index` and `inputs.<name>`. */
    inputs: z.record(z.string(), RawScalarSchema.transform(String)).optional(),
    /** A stable key per item (`{{ item.id }}`): a child run is never started twice for one key. Default: the item itself, for a list of scalars. */
    key: z.string().min(1).optional(),
    /** Title of each child's workspace, templated like `inputs`. */
    workspace_name: z.string().min(1).optional(),
    /** At most this many child runs active at once. Default 1. */
    max_active: z.number().int().positive().max(50).default(1),
    /** Cancel the active child runs when the parent run is canceled or fails, or the step is reset. Default true. */
    cancel_children: z.boolean().default(true),
    /** Work pool: the fan-out stays open and refills as children finish. Default: a batch (the join waits for every child, then the step ends). */
    pool: z
      .object({
        /** The refill pass: a run of a playbook of the folder, started whenever children have finished, that lists the items to add. */
        refill: z
          .object({
            /** The pass's playbook (not this one, not a singleton). It must be safe to run many times and use the finished keys. */
            playbook: z.string().min(1),
            /** The pass playbook's inputs. Templates over `pool.done`, `pool.failed`, `pool.active`, `pool.pending`, `pool.known` (JSON lists of keys), `pool.refill` and `inputs.<name>`. At least one must read a `pool.` value. */
            inputs: z.record(z.string(), RawScalarSchema.transform(String)).optional(),
            /** The pass playbook's output holding the list of items (same shape as `items`). Default `items`. */
            items_output: z.string().min(1).default("items"),
            /** Which finished children trigger a pass: `completed` (default) or `ended` (also failed and canceled). */
            after: z.enum(["completed", "ended"]).default("completed"),
            /** At most this many passes. Default 20, at most 500. */
            max_refills: z.number().int().positive().max(500).default(20),
            /** A pass starts once the oldest unhandled child ending, and the previous pass, are this old. Default: none. */
            debounce: z.string().optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * One operand test of a condition (`when`, a branch case's `if`): a value, a list of values (any of),
 * or `{ empty: true }` / `{ empty: false }`. The key is an input, `steps.<id>.outputs.<name>` or `steps.<id>.outcome`.
 */
const RawConditionSchema = z.record(z.string(), z.union([RawScalarSchema, z.array(RawScalarSchema).min(1), z.object({ empty: z.boolean() }).strict()]));
type RawCondition = z.infer<typeof RawConditionSchema>;

/** A branch step: ordered cases, the first whose `if` holds wins; the last one has no `if` (the else). */
const RawBranchStepSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            /** The case's name: the outcome of the branch step, which the steps of the case test in their `when`. */
            name: z.string().min(1),
            /** Conditions that must all hold. Absent on the last case only: that is the `else`. */
            if: RawConditionSchema.optional(),
            /** Ends the run (or the block, in a sub-playbook) when this case wins: `end: true`, or `end: <outcome>` of the playbook. */
            end: z.union([z.literal(true), z.string().min(1)]).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** A fan-out step's outcomes: every item completed, or at least one did not (failed, canceled or never started); `failure` is the step itself failing (bad list, timeout). */
const FANOUT_OUTCOMES = ["all_completed", "some_failed", "failure"];
/** A work pool adds one: refilling stopped (a pass failed, or `max_refills` was reached) and the running children then ended. */
const POOL_OUTCOMES = [...FANOUT_OUTCOMES, "refill_stopped"];
const POOL_OUTPUTS: Record<string, VarDef> = { refills: { type: "number" }, added: { type: "number" } };
/** A pool step with no `timeout` is bounded anyway. */
const POOL_DEFAULT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const POOL_VALUES = ["done", "failed", "active", "pending", "known", "refill"];
/** What a fan-out step reports when it joins; later steps read them as `steps.<id>.outputs.<name>`. */
const FANOUT_OUTPUTS: Record<string, VarDef> = {
  results: { type: "list" },
  total: { type: "number" },
  started: { type: "number" },
  completed: { type: "number" },
  failed: { type: "number" },
  canceled: { type: "number" },
  not_started: { type: "number" },
  any_failed: { type: "boolean" },
};

/** Fields that moved into a kind's block; read flat only to refuse them with the new form. */
const MOVED_FIELDS = { prompt: "role", silence: "role", archive_agents: "role", agent: "role", choices: "gate", poll: "script" } as const;
type MovedField = keyof typeof MOVED_FIELDS;

/** Longest step `description`, in characters. */
const STEP_DESCRIPTION_MAX = 2000;

const RawStepSchema = z.object({
    id: z.string(),
    /** Full name (details panel, graph); on a playbook step, the block's frame. Default: the id, capitalised. */
    title: z.string().min(1).optional(),
    /** Name in the Playbooks screen columns. Default: the title. */
    short_title: z.string().min(1).optional(),
    /** For people only (step sheet, graph info, get_run): why and how the step exists. Never put in an agent's prompt or brief. */
    description: z.string().trim().min(1).max(STEP_DESCRIPTION_MAX).optional(),
    needs: z.array(z.string()).default([]),
    role: kindBlock(RawRoleStepSchema).optional(),
    gate: kindBlock(RawGateStepSchema).optional(),
    playbook: kindBlock(RawPlaybookStepSchema).optional(),
    script: kindBlock(RawScriptStepSchema).optional(),
    handoff: kindBlock(RawHandoffStepSchema).optional(),
    branch: RawBranchStepSchema.optional(),
    fanout: RawFanoutStepSchema.optional(),
    /** A singleton's stage: which waiting jobs a batch takes. */
    queue: z
      .object({
        /** fifo: the oldest waiting job alone; merge: every waiting job. */
        mode: z.enum(["fifo", "merge"]).default("fifo"),
        /** How often an outcome declared `requeue` (see `settle.effects`) may put one job back at this stage; past it the job fails. Unset = no cap. */
        max_requeues: z.number().int().min(0).optional(),
        /** A script that decides which waiting jobs may join; the plugin runs it with no batch and no agent. */
        admit: z
          .object({
            /** The executable in the folder's scripts/. */
            script: z.string().min(1),
            /** Interval between checks while jobs wait (`10m`): the safety net. Required. */
            poll: z.string().optional(),
            /** Events that run a check at once; a job queued at this stage always does. */
            wake_on: RawWakeOnSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** On a batch of a singleton pipeline: the plugin settles the batch's jobs from one of the step's outputs. */
    settle: z
      .object({
        /** A string output holding YAML: per job id, `outputs` and, for a job that ends now, `outcome` (and `reason`). */
        output: z.string(),
        /** Per outcome of the singleton: what happens to the job. `continue`: it goes on in the batch; `requeue`: back to this stage's queue (no failed ride). Unlisted: it ends (terminal). */
        effects: z.record(z.string(), z.enum(["continue", "requeue"])).optional(),
      })
      .strict()
      .optional(),
    /** Runs the step only when these conditions all hold (inputs, step outputs and outcomes); otherwise it is skipped. */
    when: RawConditionSchema.optional(),
    /** How the manager is involved: start it by hand, be told of its completion. */
    manage: RawManageSchema.optional(),
    inputs: z.union([z.array(z.string()), z.record(z.string(), z.string().nullable())]).optional(),
    outputs: z.record(z.string(), RawVarDefSchema.nullable()).optional(),
    outcomes: z.array(z.string()).min(1).optional(),
    retries: z.number().int().min(0).default(0),
    timeout: z.string().optional(),
    on: z.record(z.string(), RawTransitionSchema).optional(),
    /** Moved into the kind blocks (`role:`, `gate:`, `script:`); read here to refuse them. */
    prompt: z.unknown().optional(),
    silence: z.unknown().optional(),
    archive_agents: z.unknown().optional(),
    agent: z.unknown().optional(),
    choices: z.unknown().optional(),
    poll: z.unknown().optional(),
    /** Only on a script step (inside `script:`); read here to refuse it flat. */
    wake_on: z.unknown().optional(),
    /** Moved under `queue:`; read only to refuse it. */
    admit: z.unknown().optional(),
    /** Only on after-tasks; read here to refuse it on a step. */
    trigger: z.unknown().optional(),
  });

/** An after-task: a step (role, gate or playbook) with a trigger and no needs. */
const RawAfterSchema = RawStepSchema.extend({
    trigger: z.enum(["auto", "manual"]).default("auto"),
    /** Refused: each after-task starts on its own. */
    needs: z.unknown().optional(),
  });

/** What happens to the workspace a run created for itself (`start_playbook` with `newWorkspace`). */
const RawWorkspaceSchema = z
  .object({
    /** `never` (default) keeps it; `on_end` archives it when the run completes or is canceled, if nothing else lives there. */
    archive: z.enum(["never", "on_end"]).optional(),
    /** Keep the workspace of a failed run (or one that lost its manager) for inspection. Default true. */
    keep_failed: z.boolean().optional(),
  })
  .strict();

/** Where a run's agents work: `worktree` (or `{ mode: worktree }`) gives the run a private git worktree. */
const RawIsolationSchema = z.union([
  z.enum(["none", "worktree"]),
  z
    .object({
      /** `none` (default): the workspace checkout. `worktree`: a private git worktree per run. */
      mode: z.enum(["none", "worktree"]).optional(),
      /** Submodules linked into the worktree: `none` (default; agents init what they need), `all`, or a list of paths. */
      submodules: z.union([z.enum(["none", "all"]), z.array(z.string().min(1))]).optional(),
      /** Branch the worktree starts from (its fresh origin copy). Default: the project's default branch. */
      base: z.string().min(1).optional(),
      /** `false` (default): a step whose branch deletes a submodule entry (gitlink) fails; `true` turns that guard off. */
      allow_gitlink_removal: z.boolean().optional(),
    })
    .strict(),
]);
type RawIsolation = z.infer<typeof RawIsolationSchema>;

/** `manager.mode` / `manager.lifecycle`: the value, or the message that refuses it. */
function parseManagerMode(value: string): string {
  if (value === "always_on" || value === "none") return value;
  if (value === "on_demand") return "`on_demand` is not supported yet (planned; use `always_on` or `none`)";
  return `"${value}" is not a manager mode: use \`always_on\` (default) or \`none\``;
}

/** A playbook's isolation over the defaults': the playbook's own fields win, field by field. */
function resolveIsolation(own: RawIsolation | undefined, fallback: RawIsolation | undefined): Isolation {
  const fields = (raw: RawIsolation | undefined) => (typeof raw === "string" ? { mode: raw } : (raw ?? {}));
  const merged = { ...fields(fallback), ...fields(own) } as { mode?: Isolation["mode"]; submodules?: Isolation["submodules"]; base?: string; allow_gitlink_removal?: boolean };
  return { mode: merged.mode ?? "none", submodules: merged.submodules ?? "none", base: merged.base ?? null, allowGitlinkRemoval: merged.allow_gitlink_removal ?? false };
}

const RawSlowWarningSchema = z
  .object({
    /** How many of the latest completed runs of a step make its baseline (at least 3). Default 10. */
    runs: z.number().int().min(3).optional(),
    /** A step is slow once it takes more than this many times its baseline (above 1). Default 2. */
    factor: z.number().gt(1).optional(),
  })
  .strict();

const RawPlaybookSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    /** Left out of the panel's list: for playbooks only meant as sub-playbooks or after-tasks. */
    hidden: z.boolean().default(false),
    agent: RawAgentSchema.optional(),
    /** For the Playbook Manager of runs that use this playbook. */
    manager: z
      .object({
        /** Instructions added after the manager's protocol. */
        prompt: z.string().optional(),
        /** When the plugin compacts the manager's context. */
        compact: ManagerCompactSchema.optional(),
        /** `always_on` (default): a Playbook Manager agent drives the run. `none`: no manager, the plugin drives it. */
        mode: z.string().optional(),
      })
      .strict()
      .optional(),
    workspace: RawWorkspaceSchema.optional(),
    isolation: RawIsolationSchema.optional(),
    inputs: z.record(z.string(), RawVarDefSchema.nullable()).optional(),
    outputs: z.record(z.string(), RawOutputSchema.nullable()).optional(),
    /** Removed: playbooks compose only as sub-playbook steps. Kept here to refuse it clearly. */
    next: z.unknown().optional(),
    concurrency: z.number().int().positive().optional(),
    /** A pipeline taking jobs from hand-off steps; `{}` for the defaults. A boolean is read only to refuse it. */
    singleton: z
      .union([
        z.boolean(),
        z
          .object({
            /** Branch its workspace branches off; default: the project's default branch. */
            branch: z.string().min(1).optional(),
            /** Removed in favour of stages; read only to refuse it. */
            concurrency: z.unknown().optional(),
          })
          .strict(),
      ])
      .optional(),
    /** How the playbook can end, for a parent that uses it as a sub-playbook. The first is a normal finish. */
    /** Slow-step warning: a step slower than `factor` times the mean of its last `runs` completed runs gets a warning. Defaults 10 and 2. */
    slow_warning: RawSlowWarningSchema.optional(),
    outcomes: z.array(z.string()).min(1).optional(),
    steps: z.array(RawStepSchema).min(1),
    /** Tasks run once the main graph ends (completed or failed); they never change the run's status. */
    after: z.array(RawAfterSchema).optional(),
  });

const RawRoleSchema = z.object({
    title: z.string().optional(),
    readonly: z.boolean().default(false),
    agent: RawAgentSchema.optional(),
  });

const RawDefaultsSchema = z.object({
    /** Named agent settings roles, steps and playbooks reference with `agent: { tier: <name> }`. */
    tiers: z.record(z.string(), RawTierSchema).optional(),
    agent: RawAgentSchema.optional(),
    /** `lifecycle` is the repo-wide default of a playbook's `manager.mode` (here `mode` is the manager agent's own permission mode). */
    manager: RawAgentSchema.extend({ compact: ManagerCompactSchema.optional(), lifecycle: z.string().optional() }).optional(),
    workspace: RawWorkspaceSchema.optional(),
    isolation: RawIsolationSchema.optional(),
    /** Provider failover (a tier listing several targets). */
    providers: z
      .object({
        /** How long a `provider/model` that ran out of tokens is skipped before it is tried again (`1h`). Default 1h. */
        exhausted_for: z.string().optional(),
        /** What a step does when every provider of its role is out of tokens: `fail` (to the manager) or `wait` until one recovers. Default fail. */
        on_exhausted: z.enum(["fail", "wait"]).optional(),
        /** With `on_exhausted: wait`: the longest a step waits (`12h`) before it fails to the manager. Default: no limit. */
        max_wait: z.string().optional(),
        /** `provider/model` targets every step agent of these playbooks falls back to, in order, after its own chain (`[codex/gpt-5.5, claude/claude-opus-5-5]`). Default none. */
        fallback: z.array(z.string()).optional(),
        /** Skip a target whose provider's reported usage is full, before starting on it. */
        usage: z
          .object({
            /** Read the provider usage the daemon reports (`paseo usage`) and skip full targets. Default true. */
            check: z.boolean().optional(),
            /** A target is skipped when a usage window of its provider is at or above this percentage (1-100). Default 100. */
            threshold: z.number().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Reload agent sessions that hold the tools of an older plugin generation once idle. Default true. */
    reload_stale_sessions: z.boolean().optional(),
    /** Slow-step warning: a step slower than `factor` times the mean of its last `runs` completed runs gets a warning. Defaults 10 and 2. */
    slow_warning: RawSlowWarningSchema.optional(),
    timeout: z.string().optional(),
    /** Default `manage` of every step. */
    manage: RawManageSchema.optional(),
    /** Defaults for agent steps, in the shape of a step's `role:` block. */
    role: z
      .object({
        /** Remind an agent after this long without activity (`30m`), or `off`. */
        silence: z.string().optional(),
        /** Archive a step's agents once it is done. Default true. */
        archive_agents: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Moved under `role:`; read here to refuse them. */
    silence: z.unknown().optional(),
    archive_agents: z.unknown().optional(),
  });
type RawDefaults = Omit<z.infer<typeof RawDefaultsSchema>, "tiers"> & { tiers?: Tiers; managerCompact?: ManagerCompact; managerMode?: ManagerMode };

function formatZodError(file: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${file}: ${where}: ${issue.message}`;
  });
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readYaml(file: string, rel: string): Promise<{ value: unknown } | { error: string }> {
  const text = await readText(file);
  if (text === null) return { error: `${rel}: file not found` };
  try {
    return { value: parseYaml(text) ?? {} };
  } catch (error) {
    return { error: `${rel}: invalid YAML: ${(error as Error).message}` };
  }
}

function mergeAgent(...layers: Array<AgentSettings | undefined>): AgentSettings {
  const merged: AgentSettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    // A layer that picks its own provider or model starts its own chain: the inherited fallback no longer fits.
    if (layer.provider !== undefined || layer.model !== undefined) delete merged.fallback;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

type Tiers = Record<string, AgentSettings>;

/**
 * Agent settings with their `tier` expanded: the tier's fields, then the layer's own over them.
 * An unknown tier is an error (reported through `fail`) and leaves the layer's own fields.
 */
function resolveAgent(raw: RawAgent | undefined, tiers: Tiers, at: string, fail: (message: string) => void): AgentSettings | undefined {
  if (raw === undefined) return undefined;
  const { tier, ...own } = raw;
  if (tier === undefined) return own;
  const found = tiers[tier];
  if (found && found.fallback && Object.values(own).some((value) => value !== undefined)) {
    fail(`${at}: tier "${tier}" lists several providers and cannot be combined with ${codeList(Object.keys(own).filter((key) => (own as Record<string, unknown>)[key] !== undefined))}: define another tier for that`);
    return mergeAgent(found);
  }
  if (!found) {
    const known = Object.keys(tiers);
    fail(`${at}: unknown tier "${tier}"${known.length ? ` (defined in defaults/main.yaml: ${known.join(", ")})` : "; define it under `tiers:` in defaults/main.yaml"}`);
    return own;
  }
  return mergeAgent(found, own);
}

function toVarDef(raw: z.infer<typeof RawVarDefSchema> | null): VarDef {
  const def: VarDef = { type: raw?.type ?? "string" };
  if (raw?.values) def.values = raw.values;
  if (raw?.required !== undefined) def.required = raw.required;
  if (raw?.default !== undefined) def.default = raw.default;
  if (raw?.description) def.description = raw.description;
  return def;
}

function checkVarDef(where: string, def: VarDef, errors: string[]): void {
  if (def.type === "enum" && (def.values ?? []).length === 0) errors.push(`${where}: enum needs \`values\``);
  if (def.type !== "enum" && def.values) errors.push(`${where}: \`values\` only applies to enum`);
}

// ------------------------------------------------------------------ roles and defaults

interface RoleLoad {
  role: Role | null;
  errors: string[];
}

async function loadRole(root: string, relDir: string, id: string, tiers: Tiers): Promise<RoleLoad> {
  const rel = `${relDir}/roles/${id}`;
  if (!ID.test(id)) return { role: null, errors: [`role "${id}": invalid name (lowercase letters, digits, - and _)`] };
  const raw = await readYaml(path.join(root, "roles", id, "role.yaml"), `${rel}/role.yaml`);
  const instructions = await readText(path.join(root, "roles", id, "instructions.md"));
  const errors: string[] = [];
  if ("error" in raw) errors.push(raw.error);
  if (instructions === null) errors.push(`${rel}/instructions.md: file not found`);
  else if (instructions.trim() === "") errors.push(`${rel}/instructions.md: empty`);
  if ("error" in raw || instructions === null) return { role: null, errors };
  const parsed = RawRoleSchema.safeParse(raw.value);
  if (!parsed.success) return { role: null, errors: [...errors, ...formatZodError(`${rel}/role.yaml`, parsed.error)] };
  const agent = resolveAgent(parsed.data.agent, tiers, "agent", (message) => errors.push(`${rel}/role.yaml: ${message}`));
  if (errors.length > 0) return { role: null, errors };
  return {
    role: {
      id,
      title: parsed.data.title ?? id,
      readonly: parsed.data.readonly,
      instructions: instructions.trim(),
      agent: agent ?? {},
    },
    errors: [],
  };
}

/** A `silence` value: a duration, or `off` (0). */
function parseSilence(text: string): number | null {
  return text.trim() === "off" ? 0 : parseDuration(text);
}

/** `defaults/manager.md`: repo-wide instructions for every run's manager, or null when there is none. */
async function loadManagerText(root: string, relDir: string): Promise<{ text: string | null; errors: string[] }> {
  const text = await readText(path.join(root, "defaults", "manager.md"));
  if (text === null) return { text: null, errors: [] };
  if (text.trim() === "") return { text: null, errors: [`${relDir}/defaults/manager.md: empty`] };
  return { text: text.trim(), errors: [] };
}

async function loadDefaults(root: string, relDir: string): Promise<{ defaults: RawDefaults; errors: string[] }> {
  const file = path.join(root, "defaults", "main.yaml");
  const rel = `${relDir}/defaults/main.yaml`;
  if ((await readText(file)) === null) return { defaults: {}, errors: [] };
  const raw = await readYaml(file, rel);
  if ("error" in raw) return { defaults: {}, errors: [raw.error] };
  const parsed = RawDefaultsSchema.safeParse(raw.value);
  if (!parsed.success) return { defaults: {}, errors: formatZodError(rel, parsed.error) };
  const errors: string[] = [];
  const flat = (["silence", "archive_agents"] as const).filter((field) => parsed.data[field] !== undefined);
  if (flat.length > 0) {
    const block = flowMap({ ...parsed.data.role, ...Object.fromEntries(flat.map((field) => [field, parsed.data[field]])) });
    errors.push(`${rel}: ${codeList(flat)} moved under \`role:\`: write \`role: ${block}\``);
  }
  const tiers: Tiers = {};
  for (const [name, tier] of Object.entries(parsed.data.tiers ?? {})) {
    if (!ID.test(name)) errors.push(`${rel}: tiers.${name}: invalid name (lowercase letters, digits, - and _)`);
    if (Array.isArray(tier)) {
      const [first, ...rest] = tier;
      tiers[name] = rest.length > 0 ? { ...first, fallback: rest } : { ...first };
    } else tiers[name] = tier;
  }
  const fail = (message: string) => errors.push(`${rel}: ${message}`);
  const defaults: RawDefaults = { ...parsed.data, tiers };
  if (parsed.data.agent) defaults.agent = resolveAgent(parsed.data.agent, tiers, "agent", fail);
  if (parsed.data.manager) {
    const { compact, lifecycle, ...settings } = parsed.data.manager;
    defaults.manager = resolveAgent(settings, tiers, "manager", fail);
    if (compact !== undefined) defaults.managerCompact = compact;
    if (lifecycle !== undefined) {
      const mode = parseManagerMode(lifecycle);
      if (typeof mode === "string" && ManagerModeSchema.safeParse(mode).success) defaults.managerMode = mode as ManagerMode;
      else fail(`manager.lifecycle: ${mode}`);
    }
  }
  if (parsed.data.timeout && parseDuration(parsed.data.timeout) === null) {
    errors.push(`${rel}: timeout: expected a duration such as 30m or 2h`);
  }
  if (parsed.data.providers?.exhausted_for !== undefined && parseDuration(parsed.data.providers.exhausted_for) === null) {
    errors.push(`${rel}: providers.exhausted_for: expected a duration such as 30m or 2h`);
  }
  for (const entry of parsed.data.providers?.fallback ?? []) {
    if (!/^[^/\s]+\/\S+$/.test(entry)) errors.push(`${rel}: providers.fallback: "${entry}" is not a provider/model such as claude/claude-opus-5-5`);
  }
  const threshold = parsed.data.providers?.usage?.threshold;
  if (threshold !== undefined && !(threshold > 0 && threshold <= 100)) errors.push(`${rel}: providers.usage.threshold: expected a percentage from 1 to 100, got ${threshold}`);
  if (parsed.data.providers?.max_wait !== undefined) {
    if (parsed.data.providers.on_exhausted !== "wait") errors.push(`${rel}: providers.max_wait only applies with providers.on_exhausted: wait`);
    if (parseDuration(parsed.data.providers.max_wait) === null) errors.push(`${rel}: providers.max_wait: expected a duration such as 30m or 2h`);
  }
  if (parsed.data.role?.silence && parseSilence(parsed.data.role.silence) === null) {
    errors.push(`${rel}: role.silence: expected a duration such as 30m, or off`);
  }
  return { defaults, errors };
}

/**
 * The manager's added instructions: the repository's, this playbook's, then its sub-playbooks'
 * (which already list theirs, nested ones included), each playbook once.
 */
function managerInstructions(repo: string | null, id: string, prompt: string | undefined, subs: Playbook[]): Playbook["managerInstructions"] {
  const list: Playbook["managerInstructions"] = repo ? [{ playbook: null, text: repo }] : [];
  if (prompt?.trim()) list.push({ playbook: id, text: prompt.trim() });
  for (const sub of subs) {
    for (const entry of sub.managerInstructions) {
      if (entry.playbook !== null && !list.some((other) => other.playbook === entry.playbook)) list.push(entry);
    }
  }
  return list;
}

/** A value written as YAML flow, for error messages: short scalars as they are, the rest as `…`. */
function flowValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    if (value.includes("\n") || value.length > 40) return "…";
    return /^[\w./-][\w ./?-]*$/.test(value) && !/^(true|false|null|~)$/.test(value) ? value : JSON.stringify(value);
  }
  if (value === null) return "~";
  if (value instanceof Placeholder) return value.text;
  if (Array.isArray(value)) return "[ … ]";
  if (typeof value === "object") return flowMap(value as Record<string, unknown>);
  return "…";
}

/** `a`, `b` and `c`. */
function codeList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0] ?? "";
}

/** A map written as one-line YAML flow, for error messages. */
function flowMap(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  return `{ ${entries.map(([key, value]) => `${key}: ${flowValue(value)}`).join(", ")} }`;
}

// ------------------------------------------------------------------ playbooks

export interface LoadResult {
  /** Absolute paths of the playbook folders that exist. */
  roots: string[];
  exists: boolean;
  entries: PlaybookEntry[];
  /** The project's Sidekick (`sidekick/` beside the playbooks), or `configured: false` when there is none. */
  sidekick: SidekickLoad;
  /** The profiles found in `profiles/`, active or not. */
  profiles: ProfileInfo[];
  /** Whether the `default` repository was loaded (the project can turn it off). */
  defaultActive: boolean;
  /** Notes about the layout (legacy folder, ignored folders, shared ids); not errors of a playbook. */
  diagnostics: string[];
}

export type { ProfileInfo };

/** The `sidekick/sidekick.yaml` block: all optional. `watch` lists the event types the Sidekick is told about. */
const RawSidekickSchema = z
  .object({
    sidekick: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        mode: z.string().optional(),
        thinking: z.string().optional(),
        /** Event types (or globs such as `gate.*`) it is subscribed to, for this project's runs. */
        watch: z.array(z.string().min(1)).min(1).optional(),
        /** Provider and model of the subagents the Sidekick creates (default: claude / claude-sonnet-5-5). */
        subagents: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional(), mode: z.unknown().optional() }).strict().optional(),
        session: z.object({ restart_above_tokens: z.number().int().positive().optional() }).strict().optional(),
        /** Rules for the runs the Sidekick starts. Enforced by its prompt only. */
        runs: z
          .object({
            /** At most this many runs of the project active at once (default: unlimited). */
            max_concurrent: z.number().int().positive().optional(),
            /** Ask the human before launching more than one run in a batch (default false). */
            confirm_bulk: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Event types a Sidekick watches when `sidekick.watch` is not set. */
export const DEFAULT_SIDEKICK_WATCH = ["gate.escalated", "run.failed", "run.manager_lost"];

export interface SidekickConfig {
  provider?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  watch: string[];
  /** Context size above which the Sidekick is restarted with a hand-off; default 300000. */
  restartAboveTokens?: number;
  subagents?: { provider?: string; model?: string; mode?: string };
  /** `sidekick.runs`: rules for the runs it starts; unset means unlimited and no confirmation. */
  runs?: { maxConcurrent?: number; confirmBulk?: boolean };
}

export interface SidekickLoad {
  /** A `sidekick/` folder exists in a playbooks folder. Without it the project has no Sidekick. */
  configured: boolean;
  /** Folder of the Sidekick, relative to the workspace (`.paseo/plugins/playbooks/sidekick`). */
  dir: string | null;
  config: SidekickConfig | null;
  /** `sidekick/instructions.md`, trimmed; null when there is none. */
  instructions: string | null;
  errors: string[];
  /** Values ignored (not errors): the Sidekick still starts. */
  warnings: string[];
}

const NO_SIDEKICK: SidekickLoad = { configured: false, dir: null, config: null, instructions: null, errors: [], warnings: [] };

/** A Paseo agent mode id (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, a provider's own). */
const MODE_ID = /^[A-Za-z][A-Za-z0-9_:.-]*$/;

/**
 * The Sidekick of a project: `sidekick/sidekick.yaml` and `sidekick/instructions.md` in the first playbooks
 * folder that has a `sidekick/` directory. A directory, so it never takes the id of a playbook (`sidekick.yaml`
 * in the folder itself is a playbook and coexists with it).
 */
export async function loadSidekick(workspaceDir: string): Promise<SidekickLoad> {
  for (const relDir of PLAYBOOKS_DIRS) {
    const dir = path.join(workspaceDir, relDir, "sidekick");
    if ((await listFolder(dir)) === null) continue;
    const rel = `${relDir}/sidekick`;
    const errors: string[] = [];
    const warnings: string[] = [];
    let config: SidekickConfig = { watch: DEFAULT_SIDEKICK_WATCH };
    if ((await readText(path.join(dir, "sidekick.yaml"))) !== null) {
      const raw = await readYaml(path.join(dir, "sidekick.yaml"), `${rel}/sidekick.yaml`);
      if ("error" in raw) errors.push(raw.error);
      else {
        const parsed = RawSidekickSchema.safeParse(raw.value);
        if (!parsed.success) errors.push(...formatZodError(`${rel}/sidekick.yaml`, parsed.error));
        else {
          const { watch, session, runs, subagents: rawSubagents, ...settings } = parsed.data.sidekick ?? {};
          let subagents: { provider?: string; model?: string; mode?: string } | undefined;
          if (rawSubagents) {
            const { mode, ...rest } = rawSubagents;
            subagents = rest;
            if (mode !== undefined) {
              if (typeof mode === "string" && MODE_ID.test(mode)) subagents.mode = mode;
              else warnings.push(`${rel}/sidekick.yaml: sidekick.subagents.mode must be a mode id such as default, acceptEdits, plan, auto or bypassPermissions; ignored`);
            }
          }
          config = {
            ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)),
            watch: watch ?? DEFAULT_SIDEKICK_WATCH,
            ...(subagents && (subagents.provider || subagents.model || subagents.mode) ? { subagents: Object.fromEntries(Object.entries(subagents).filter(([, value]) => value !== undefined)) } : {}),
            ...(session?.restart_above_tokens ? { restartAboveTokens: session.restart_above_tokens } : {}),
            ...(runs && (runs.max_concurrent !== undefined || runs.confirm_bulk !== undefined)
              ? { runs: { ...(runs.max_concurrent !== undefined ? { maxConcurrent: runs.max_concurrent } : {}), ...(runs.confirm_bulk !== undefined ? { confirmBulk: runs.confirm_bulk } : {}) } }
              : {}),
          };
        }
      }
    }
    let instructions: string | null = null;
    const text = await readText(path.join(dir, "instructions.md"));
    if (text !== null) {
      if (text.trim() === "") errors.push(`${rel}/instructions.md: empty`);
      else instructions = text.trim();
    }
    return { configured: true, dir: rel, config: errors.length > 0 ? null : config, instructions, errors, warnings };
  }
  return NO_SIDEKICK;
}

/** True when the workspace has at least one playbook file in any playbook folder. */
/** `reload_stale_sessions` of the workspace's `defaults/main.yaml` (the first playbooks folder that has one); true when unset. */
export async function reloadStaleSessionsSetting(workspaceDir: string): Promise<boolean> {
  for (const relDir of PLAYBOOKS_DIRS) {
    const file = path.join(workspaceDir, relDir, "defaults", "main.yaml");
    if ((await readText(file)) === null) continue;
    const raw = await readYaml(file, `${relDir}/defaults/main.yaml`);
    if ("error" in raw) return true;
    const parsed = RawDefaultsSchema.safeParse(raw.value);
    return parsed.success ? (parsed.data.reload_stale_sessions ?? true) : true;
  }
  return true;
}

export async function hasPlaybooks(workspaceDir: string): Promise<boolean> {
  for (const relDir of PLAYBOOKS_DIRS) {
    try {
      const names = await readdir(path.join(workspaceDir, relDir));
      if (names.some((name) => name.endsWith(".yaml") || name.endsWith(".yml"))) return true;
    } catch {
      // Folder absent.
    }
  }
  // A workspace with only profiles still shows the screen, so they can be turned on.
  const profiles = (await listFolder(path.join(workspaceDir, PLAYBOOKS_DIRS[0], PROFILES_DIR))) ?? [];
  for (const name of profiles) {
    const files = await listFolder(path.join(workspaceDir, PLAYBOOKS_DIRS[0], PROFILES_DIR, name));
    if (files?.some((file) => /\.ya?ml$/.test(file))) return true;
  }
  return false;
}

async function listFolder(root: string): Promise<string[] | null> {
  try {
    if (!(await stat(root)).isDirectory()) return null;
    return await readdir(root);
  } catch {
    return null;
  }
}

/** Folder of the profiles, inside the primary playbooks folder: `profiles/<id>/` is a repository like the folder itself. */
export const PROFILES_DIR = "profiles";

/** Loads one repository folder (the playbooks folder itself, or a profile): its entries, using its own roles/, defaults/ and scripts/. */
async function loadRepo(repo: string, root: string, relDir: string, names: string[]): Promise<PlaybookEntry[]> {
  const entries: PlaybookEntry[] = [];
  const files = names.filter((name) => /\.ya?ml$/.test(name)).sort();
  const { defaults, errors: mainErrors } = await loadDefaults(root, relDir);
  const { text: managerText, errors: managerErrors } = await loadManagerText(root, relDir);
  const defaultsErrors = [...mainErrors, ...managerErrors];
  const roleCache = new Map<string, Promise<RoleLoad>>();
  const role = (id: string) => {
    if (!roleCache.has(id)) roleCache.set(id, loadRole(root, relDir, id, defaults.tiers ?? {}));
    return roleCache.get(id)!;
  };
  const loads = new Map<string, Promise<Loaded>>();
  const folder: Folder = {
    root,
    relDir,
    repo,
    defaults,
    managerText,
    role,
    ids: new Set(files.map((name) => name.replace(/\.ya?ml$/, ""))),
    load: (id, stack) => {
      if (!loads.has(id)) {
        const name = files.find((candidate) => candidate.replace(/\.ya?ml$/, "") === id)!;
        loads.set(id, loadPlaybook(folder, name, `${relDir}/${name}`, id, stack));
      }
      return loads.get(id)!;
    },
  };
  for (const name of files) {
    const id = name.replace(/\.ya?ml$/, "");
    const { entry } = await folder.load(id, []);
    if (defaultsErrors.length > 0) {
      entry.errors.unshift(...defaultsErrors);
      entry.playbook = null;
    }
    entries.push(entry);
  }
  return entries;
}

/** The valid profile folders of a checkout (sorted), and a note for each folder that is not one. */
async function scanProfiles(dir: string): Promise<{ found: Array<{ name: string; root: string; files: string[] }>; diagnostics: string[] }> {
  const found: Array<{ name: string; root: string; files: string[] }> = [];
  const diagnostics: string[] = [];
  const profilesRel = `${PLAYBOOKS_DIRS[0]}/${PROFILES_DIR}`;
  for (const name of ((await listFolder(path.join(dir, profilesRel))) ?? []).sort()) {
    if (name.startsWith(".")) continue;
    const root = path.join(dir, profilesRel, name);
    const files = await listFolder(root);
    if (files === null) continue; // a stray file, not a profile
    if (name === DEFAULT_REPO || !ID.test(name)) {
      diagnostics.push(`${profilesRel}/${name}: not a profile (${name === DEFAULT_REPO ? "`default` is the main repository" : "profile folder names use lowercase letters, digits, - and _"}); ignored`);
      continue;
    }
    found.push({ name, root, files });
  }
  return { found, diagnostics };
}

/**
 * The repositories a project offers, read from its main checkout (`root`), with the project's setting applied:
 * `default` first (its playbook files, active unless the project turned it off), then each profile.
 */
export async function projectProfiles(root: string, projectId: string): Promise<{ profiles: ProfileInfo[]; diagnostics: string[] }> {
  const active = await readProjectProfiles(projectId);
  const { found, diagnostics } = await scanProfiles(root);
  let defaultPlaybooks = 0;
  for (const relDir of PLAYBOOKS_DIRS) defaultPlaybooks += ((await listFolder(path.join(root, relDir))) ?? []).filter((file) => /\.ya?ml$/.test(file)).length;
  return {
    profiles: [{ id: DEFAULT_REPO, active: await readProjectDefault(projectId), playbooks: defaultPlaybooks, errors: [] }].concat(found.map(({ name, files }) => ({ id: name, active: active.includes(name), playbooks: files.filter((file) => /\.ya?ml$/.test(file)).length, errors: [] }))),
    diagnostics,
  };
}

export interface LoadOptions {
  /** Profiles to activate; overrides the project's setting. */
  activeProfiles?: string[];
  /** The project whose profile setting (`profiles.projects.<project>.active` of the user config) applies. Without it, and without `activeProfiles`, no profile is active. */
  projectId?: string;
  /** Whether to load the `default` repository; overrides the project's setting (on unless the project turned it off, and on without a project). */
  defaultActive?: boolean;
}

/**
 * Loads and validates the playbooks of the workspace: the default repository (`.paseo/plugins/playbooks/` and
 * `.paseo/playbooks/`, unless the project turned it off) plus each active profile (`.paseo/plugins/playbooks/profiles/<id>/`, same layout).
 * Each repository uses its own roles/ and defaults/, so a playbook never resolves anything from another one.
 * A playbook of a profile goes by `<profile>:<id>`; the same bare id in two repositories is allowed (and reported),
 * the same id in both default folders is an error.
 */
export async function loadPlaybooks(workspaceDir: string, options: LoadOptions = {}): Promise<LoadResult> {
  const roots: string[] = [];
  const entries: PlaybookEntry[] = [];
  const diagnostics: string[] = [];
  const defaultActive = options.defaultActive ?? (options.projectId ? await readProjectDefault(options.projectId) : true);
  for (const relDir of PLAYBOOKS_DIRS) {
    const root = path.join(workspaceDir, relDir);
    const names = await listFolder(root);
    if (names === null) continue;
    roots.push(root);
    if (defaultActive) entries.push(...(await loadRepo(DEFAULT_REPO, root, relDir, names)));
  }
  // The same id twice in the default repository would be a silent pick: refuse both.
  for (const entry of entries) {
    const clashes = entries.filter((other) => other !== entry && other.id === entry.id);
    if (clashes.length === 0) continue;
    entry.errors.push(`${entry.file}: playbook id "${entry.id}" is also defined in ${clashes.map((other) => other.file).join(", ")}; rename one`);
    entry.playbook = null;
  }
  if (defaultActive && roots.length > 1) diagnostics.push(`${PLAYBOOKS_DIRS[1]}/ is the legacy location: it is read as part of the default repository, next to ${PLAYBOOKS_DIRS[0]}/ (move its files there when convenient)`);

  // Profiles: each direct subfolder of profiles/ in the primary folder, active only when the project turned it on.
  const profiles: ProfileInfo[] = [];
  const profilesRel = `${PLAYBOOKS_DIRS[0]}/${PROFILES_DIR}`;
  const requested = options.activeProfiles ?? (options.projectId ? await readProjectProfiles(options.projectId) : []);
  const scan = await scanProfiles(workspaceDir);
  diagnostics.push(...scan.diagnostics);
  // An id with no folder here (it may live in the project's main checkout only) is ignored.
  for (const { name, root, files } of scan.found) {
    const active = requested.includes(name);
    const info: ProfileInfo = { id: name, active, playbooks: files.filter((file) => /\.ya?ml$/.test(file)).length, errors: [] };
    profiles.push(info);
    if (info.playbooks === 0) diagnostics.push(`${profilesRel}/${name}: no playbook files`);
    if (!active) continue;
    try {
      const loaded = await loadRepo(name, root, `${profilesRel}/${name}`, files);
      entries.push(...loaded);
    } catch (error) {
      info.errors.push(`could not load: ${error instanceof Error ? error.message : String(error)}`);
      diagnostics.push(`${profilesRel}/${name}: could not load: ${info.errors[0]}`);
    }
  }
  // Same bare id in several repositories: both stay (qualified), but a bare reference to it is ambiguous.
  const byBare = new Map<string, PlaybookEntry[]>();
  for (const entry of entries) byBare.set(bareId(entry.id), [...(byBare.get(bareId(entry.id)) ?? []), entry]);
  for (const [id, group] of byBare) {
    const repos = new Set(group.map((entry) => entry.repo));
    if (repos.size > 1) diagnostics.push(`playbook id "${id}" exists in ${[...repos].map((repo) => `\`${repo}\``).join(" and ")}: refer to it as ${group.map((entry) => `\`${qualified(entry)}\``).join(" or ")} (a bare "${id}" is ambiguous)`);
  }
  return { roots, exists: roots.length > 0 || profiles.length > 0, entries, sidekick: await loadSidekick(workspaceDir), profiles, defaultActive, diagnostics };
}

/**
 * A script step's file: a plain name in the folder's scripts/ (no path), executable. Its
 * shebang picks the interpreter.
 */
async function checkScript(root: string, name: string): Promise<{ name: string } | { error: string }> {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return { error: `"${name}" must be a file name in scripts/ (letters, digits, ., - and _; no path)` };
  const file = path.join(root, "scripts", name);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return { error: `scripts/${name} not found` };
  if (!(await access(file, constants.X_OK).then(() => true, () => false))) return { error: `scripts/${name} is not executable (chmod +x it)` };
  return { name };
}

/** One playbook folder: its files, defaults, roles, and a cached loader for sub-playbooks. */
interface Folder {
  root: string;
  relDir: string;
  /** The repository: `default` for the playbooks folders, a profile's id otherwise. */
  repo: string;
  defaults: RawDefaults;
  /** `defaults/manager.md`, trimmed. */
  managerText: string | null;
  role: (id: string) => Promise<RoleLoad>;
  ids: Set<string>;
  /** `stack` holds the playbooks being expanded above this one, to refuse self-inclusion. */
  load: (id: string, stack: string[]) => Promise<Loaded>;
}

type Loaded = { entry: PlaybookEntry };

/** The id a repository's playbook goes by: bare in the default repository, `profile:id` in a profile. */
export function qualifyId(repo: string, id: string): string {
  return repo === DEFAULT_REPO ? id : `${repo}:${id}`;
}

async function loadPlaybook(folder: Folder, name: string, file: string, id: string, stack: string[]): Promise<Loaded> {
  const { root, defaults, role } = folder;
  const qid = qualifyId(folder.repo, id);
  const entry: PlaybookEntry = { id: qid, repo: folder.repo, file, title: id, hidden: false, errors: [], playbook: null };
  const fail = (errors: string[]) => {
    entry.errors.push(...errors);
    return { entry };
  };
  if (!ID.test(id)) return fail([`${file}: playbook file names use lowercase letters, digits, - and _`]);
  const raw = await readYaml(path.join(root, name), file);
  if ("error" in raw) return fail([raw.error]);
  const parsed = RawPlaybookSchema.safeParse(raw.value);
  if (!parsed.success) return fail(formatZodError(file, parsed.error));
  const pb = parsed.data;
  entry.title = pb.title ?? id;
  entry.hidden = pb.hidden;
  const errors: string[] = [];
  const err = (message: string) => errors.push(`${file}: ${message}`);
  if (pb.next !== undefined) err("`next` was removed; include the other playbook as a sub-playbook step (`playbook: { name: <id> }`) instead");

  // Playbook inputs.
  const inputs: Record<string, VarDef> = {};
  for (const [name, rawDef] of Object.entries(pb.inputs ?? {})) {
    if (!ID.test(name)) err(`inputs.${name}: invalid name`);
    inputs[name] = toVarDef(rawDef);
    checkVarDef(`${file}: inputs.${name}`, inputs[name]!, errors);
  }

  // Singleton: takes jobs from hand-off steps; its key inputs are each run's, the others each job's.
  let singleton: Playbook["singleton"];
  if (typeof pb.singleton === "boolean") err(`singleton: a feature is a block: write \`singleton: {}\` for the defaults, or leave it out`);
  if (pb.singleton !== undefined && typeof pb.singleton !== "boolean") {
    const raw = pb.singleton;
    singleton = { stages: [] };
    if (raw.branch !== undefined) singleton.branch = raw.branch;
    if (raw.concurrency !== undefined) {
      err("singleton.concurrency was removed: each top-level step is a stage with its own waiting list; set `queue: { mode: fifo | merge }` on a step instead");
    }
    if (pb.concurrency !== undefined) err("`concurrency` does not apply to a singleton playbook: each top-level step is a stage, which runs one batch at a time");
    if (pb.after !== undefined) err("`after` does not apply to a singleton playbook (its pipeline never ends)");
  }
  // A singleton has no run inputs: every input is each job's.
  const keyInputs = new Set<string>();

  /**
   * A condition map (a step's `when`, a branch case's `if`): each key is an input of the playbook (a key
   * input on a singleton), `steps.<id>.outputs.<name>` or `steps.<id>.outcome`. Inputs are checked here,
   * step references once the graph is known (checkStepRefs).
   */
  const parseWhen = (where: string, raw: RawCondition | undefined, label = "when"): When[] | undefined => {
    if (raw === undefined) return undefined;
    const conditions: When[] = [];
    for (const [name, given] of Object.entries(raw)) {
      const ref = /^steps\.([a-z][a-z0-9_.-]*?)\.(?:outputs\.([A-Za-z_][\w-]*)|(outcome))$/.exec(name);
      const def = ref ? undefined : inputs[name];
      const source = ref ? `{{ steps.${ref[1]}.${ref[3] ? "outcome" : `outputs.${ref[2]}`} }}` : `{{ playbook.inputs.${name} }}`;
      if (name === "loop" && !def) {
        const tests: NonNullable<When["loop"]> = [];
        for (const value of Array.isArray(given) ? given : [given]) {
          const match = /^\s*(==|=|>=|<=|>|<)?\s*(\d+)\s*$/.exec(String(value));
          if (match) tests.push({ op: match[1] === undefined || match[1] === "=" ? "==" : (match[1] as "==" | ">=" | "<=" | ">" | "<"), value: Number(match[2]) });
          else err(`${where}: ${label}.loop: ${JSON.stringify(value)}: expected a loop count such as 1, ">=2" or "<3"`);
        }
        if (tests.length > 0) conditions.push({ input: "loop", source: "", values: [], loop: tests });
        continue;
      }
      if (!ref && !def) {
        err(`${where}: ${label}.${name}: not an input of this playbook${Object.keys(inputs).length ? ` (${Object.keys(inputs).join(", ")})` : ""}; to test a step write \`steps.<id>.outputs.<name>\` or \`steps.<id>.outcome\``);
        continue;
      }
      if (singleton && (ref || !keyInputs.has(name))) {
        err(`${where}: ${label}.${name}: a singleton's inputs are each job's${ref ? ", and its batches do not read other steps in a condition" : ""}, so \`${label}\` cannot use ${ref ? "this" : "them"}; put the condition in the stage's sub-playbook, on an input the stage sets`);
        continue;
      }
      if (typeof given === "object" && !Array.isArray(given)) {
        conditions.push({ input: name, source, values: [], empty: given.empty });
        continue;
      }
      const values: string[] = [];
      for (const value of Array.isArray(given) ? given : [given]) {
        // Step values are checked against the step's output type later; an input's now.
        const coerced = def ? coerceValue(def, value) : { ok: true as const, value };
        if (coerced.ok) values.push(String(coerced.value));
        else err(`${where}: ${label}.${name}: ${JSON.stringify(value)}: ${coerced.error}`);
      }
      conditions.push({ input: name, source, values });
    }
    return conditions.length > 0 ? conditions : undefined;
  };

  // Playbook outcomes: the first is a normal finish, `{ end: <outcome> }` picks another.
  const playbookOutcomes = pb.outcomes ?? ["success"];
  for (const outcome of playbookOutcomes) if (!ID.test(outcome)) err(`outcomes.${outcome}: invalid name (lowercase letters, digits, - and _)`);
  if (new Set(playbookOutcomes).size !== playbookOutcomes.length) err("outcomes: duplicate outcome");
  /** An `end` transition: a plain `end`, or `{ end: <outcome> }` with one of the playbook's outcomes. */
  const endTransition = (where: string, outcome: string | undefined): Transition => {
    if (outcome === undefined) return { kind: "end" };
    if (!playbookOutcomes.includes(outcome)) {
      err(`${where}: end: "${outcome}" is not an outcome of this playbook (${playbookOutcomes.join(", ")}); declare it in the playbook's \`outcomes\``);
    }
    return { kind: "end", outcome };
  };

  // Main steps, then after-tasks as steps of their own (no needs), marked with their task id.
  const rawAll: Array<{ raw: RawStep; task: string | undefined }> = [
    ...pb.steps.map((raw) => ({ raw, task: undefined })),
    ...(pb.after ?? []).map((raw) => ({ raw: { ...raw, needs: [] } as RawStep, task: raw.id })),
  ];
  for (const raw of pb.steps) if (raw.trigger !== undefined) err(`step "${raw.id}": \`trigger\` only applies to an after-task`);
  for (const raw of pb.after ?? []) if (raw.needs !== undefined) err(`after "${raw.id}": \`needs\` does not apply to an after-task (each one starts when the run ends)`);

  const tiers = defaults.tiers ?? {};
  const playbookAgent = resolveAgent(pb.agent, tiers, "agent", err);

  // Roles used by agent steps.
  const roles: Record<string, Role> = {};
  const deciderRoles = rawAll.flatMap(({ raw: step }) => [kindBlocks(step).gate?.decider, ...Object.values(step.on ?? {}).map((transition) => (typeof transition === "object" && "decider" in transition ? transition.decider : undefined))].flatMap((decider) => (decider?.by === "role" && decider.role ? [decider.role] : [])));
  for (const roleId of new Set([...rawAll.flatMap(({ raw: step }) => kindBlocks(step).role?.name ?? []), ...deciderRoles])) {
    const loaded = await role(roleId);
    if (loaded.role) roles[roleId] = loaded.role;
    else errors.push(...loaded.errors.map((message) => `${file}: role "${roleId}": ${message}`));
  }

  /** A gate's `decider`: `role` goes with `by: role` only, and names a readonly role. */
  /** A goto's `delay` in ms: a duration such as 30s, 2m or 1h, or an error. */
  const gotoDelay = (at: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const ms = parseDuration(raw);
    if (ms === null) err(`${at}: expected a duration such as 30s, 2m or 1h`);
    return ms ?? undefined;
  };
  const parseDecider = (at: string, raw: RawDecider | undefined): GateDecider | undefined => {
    if (raw === undefined) return undefined;
    if (raw.by !== "role") {
      if (raw.role !== undefined) err(`${at}.role: only applies with \`by: role\``);
      if (raw.agent !== undefined) err(`${at}.agent: only applies with \`by: role\` (only a role decider runs an agent)`);
      return { by: raw.by };
    }
    if (raw.role === undefined) {
      err(`${at}: \`by: role\` needs a \`role\`: write \`decider: { by: role, role: <id> }\``);
      return undefined;
    }
    const decider = roles[raw.role];
    if (decider && !decider.readonly) err(`${at}.role: role "${raw.role}" decides gates, so it must be \`readonly: true\``);
    return { by: "role", role: raw.role, agent: mergeAgent(defaults.agent, playbookAgent, decider?.agent, resolveAgent(raw.agent, tiers, `${at}.agent`, err)) };
  };

  // Steps, first pass. A `playbook:` step is a placeholder until expansion below.
  const seen = new Set<string>();
  const steps: Step[] = [];
  const blocks = new Map<string, Playbook>();
  const handoffs = new Map<string, Playbook>();
  const defaultTimeout = defaults.timeout ? parseDuration(defaults.timeout) ?? undefined : undefined;
  const defaultSilence = defaults.role?.silence ? parseSilence(defaults.role.silence) ?? undefined : undefined;
  for (const { raw: rawStep, task } of rawAll) {
    const where = task ? `after "${rawStep.id}"` : `step "${rawStep.id}"`;
    const afterTask = task ? { afterTask: task } : {};
    if (!ID.test(rawStep.id)) err(`${where}: invalid id (lowercase letters, digits, - and _)`);
    if (RESERVED_STEP_IDS.has(rawStep.id)) err(`${where}: "${rawStep.id}" is reserved`);
    if (seen.has(rawStep.id)) err(`${where}: duplicate id`);
    seen.add(rawStep.id);
    const { role: roleStep, gate: gateStep, script: scriptStep, playbook: playbookStep } = kindBlocks(rawStep);
    const isGate = gateStep !== undefined;
    const isBlock = playbookStep !== undefined;
    const isScript = scriptStep !== undefined;
    const isHandoff = rawStep.handoff !== undefined;
    if ([roleStep, gateStep, playbookStep, scriptStep, rawStep.handoff, rawStep.branch, rawStep.fanout].filter((value) => value !== undefined).length !== 1) {
      err(`${where}: set exactly one of \`role\`, \`gate\`, \`playbook\`, \`script\`, \`handoff\`, \`branch\` or \`fanout\``);
    }
    refuseFlatForms(where, rawStep, err);
    if (typeof rawStep.handoff === "string") err(`${where}: handoff: write \`handoff: { name: ${rawStep.handoff} }\``);
    if (task && rawStep.when !== undefined) err(`${where}: \`when\` does not apply to an after-task`);
    if (rawStep.branch !== undefined && (task || singleton)) err(`${where}: \`branch\` does not apply to ${task ? "an after-task" : "a singleton's stage"}`);
    if (rawStep.when && "loop" in rawStep.when && !inputs.loop && kindBlocks(rawStep).playbook !== undefined) {
      err(`${where}: when.loop does not apply to a playbook step (it has no loop count); put it on a step of the sub-playbook`);
    }
    const when = task ? undefined : parseWhen(where, rawStep.when);
    const conditional = when ? { when } : {};
    if (rawStep.fanout !== undefined && (task || singleton)) err(`${where}: \`fanout\` does not apply to ${task ? "an after-task" : "a singleton's stage"}`);
    if (rawStep.settle !== undefined && (isGate || isBlock || isHandoff || task || rawStep.fanout !== undefined)) {
      err(`${where}: \`settle\` only applies to a role or script step (its outputs settle the batch's jobs)`);
    }
    if (rawStep.branch !== undefined) {
      for (const field of ["inputs", "outputs", "outcomes", "timeout", "on", "settle"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a branch step (its outcome is the case that won)`);
      }
      if (rawStep.retries !== 0) err(`${where}: \`retries\` does not apply to a branch step`);
      const cases = rawStep.branch.cases.map((raw, index) => {
        const at = `${where}: branch.cases[${index}]`;
        if (!ID.test(raw.name)) err(`${at}: invalid name "${raw.name}" (lowercase letters, digits, - and _)`);
        const last = index === rawStep.branch!.cases.length - 1;
        if (raw.if === undefined && !last) err(`${at}: "${raw.name}" has no \`if\`, so it is the else and must be the last case: the ${rawStep.branch!.cases.length - 1 - index} case(s) after it can never run`);
        if (raw.if !== undefined && Object.keys(raw.if).length === 0) err(`${at}: \`if\` is empty; list at least one condition, or leave it out for the else`);
        const end = raw.end === undefined ? undefined : endTransition(`${at}: end`, raw.end === true ? undefined : raw.end);
        return { name: raw.name, ...(raw.if !== undefined ? { when: parseWhen(at, raw.if, "if") } : {}), ...(end ? { end: end.kind === "end" && end.outcome !== undefined ? { outcome: end.outcome } : {} } : {}) };
      });
      const lastCase = rawStep.branch.cases.at(-1)!;
      if (lastCase.if !== undefined) err(`${where}: branch has no else: end the cases with one that has no \`if\` (e.g. \`{ name: other }\`), so every run takes a branch`);
      const names = cases.map((candidate) => candidate.name);
      for (const name of names) if (names.indexOf(name) !== names.lastIndexOf(name)) err(`${where}: branch: duplicate case name "${name}"`);
      // A case is unreachable when an earlier one holds in every state where it does: each of that case's
      // tests also appears in this one, with the same or fewer values.
      for (const [index, later] of cases.entries()) {
        const earlier = cases.slice(0, index).find((candidate) => {
          const held = candidate.when ?? [];
          return held.length > 0 && held.every((test) => (later.when ?? []).some((other) => sameOrNarrower(other, test)));
        });
        if (earlier && later.when) err(`${where}: branch case "${later.name}" is unreachable: whenever it holds, the earlier case "${earlier.name}" holds and wins`);
      }
      steps.push({
        id: rawStep.id,
        kind: "branch",
        needs: rawStep.needs,
        prompt: "",
        inputs: {},
        outputs: {},
        outcomes: names,
        retries: 0,
        agent: {},
        on: {},
        choices: [],
        branch: { cases },
        ...(rawStep.title !== undefined ? { title: rawStep.title } : {}),
        ...(rawStep.description !== undefined ? { description: rawStep.description } : {}),
        ...(rawStep.short_title !== undefined ? { shortTitle: rawStep.short_title } : {}),
        ...conditional,
      });
      continue;
    }
    if (isBlock) {
      for (const field of ["outputs", "outcomes", "timeout"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a playbook step (the sub-playbook defines it)`);
      }
      if (rawStep.short_title !== undefined) err(`${where}: \`short_title\` does not apply to a playbook step (its steps are the columns)`);
      const subId = playbookStep.name;
      let sub: Playbook | null = null;
      if (subId === id || stack.includes(subId)) {
        err(`${where}: playbook "${subId}" includes itself (${[...stack, id, subId].join(" → ")})`);
      } else if (!folder.ids.has(subId)) {
        err(`${where}: playbook "${subId}" not found in ${folder.relDir}/`);
      } else {
        const loaded = await folder.load(subId, [...stack, id]);
        sub = loaded.entry.playbook;
        if (!sub) err(`${where}: playbook "${subId}" is invalid: ${loaded.entry.errors[0] ?? "see that file"}`);
        else if (sub.singleton) {
          err(`${where}: playbook "${subId}" is a singleton: its runs only come from hand-offs and Start, so it cannot be ${task ? "an after-task" : "a sub-playbook"}; use \`handoff: { name: ${subId} }\``);
          sub = null;
        }
      }
      if (sub) blocks.set(rawStep.id, sub);
      // `on` maps the sub-playbook's outcomes; the first one (a normal finish) continues by default.
      const on: Record<string, Transition> = {};
      if (task && rawStep.on !== undefined) err(`${where}: \`on\` does not apply to an after-task (it ends on its own, whatever the outcome)`);
      else if (sub) {
        for (const [outcome, transition] of Object.entries(rawStep.on ?? {})) {
          if (!sub.outcomes.includes(outcome)) {
            err(`${where}: on.${outcome}: not an outcome of playbook "${subId}" (${sub.outcomes.join(", ")})`);
          } else if (typeof transition === "string") {
            on[outcome] = { kind: transition };
          } else if ("end" in transition) {
            on[outcome] = endTransition(`${where}: on.${outcome}`, transition.end);
          } else {
            err(`${where}: on.${outcome}: a playbook step's outcome leads to complete, end or fail (\`goto\` and \`ask\` apply to agent steps and gates)`);
          }
        }
        for (const outcome of sub.outcomes.slice(1)) {
          if (!on[outcome] && !task) err(`${where}: outcome "${outcome}" of playbook "${subId}" needs an \`on\` entry (complete, end or fail)`);
        }
      }
      steps.push({
        id: rawStep.id,
        kind: "agent",
        needs: rawStep.needs,
        prompt: "",
        inputs: {},
        outputs: Object.fromEntries(Object.entries(sub?.outputs ?? {}).map(([name, def]) => [name, { type: def.type, ...(def.values ? { values: def.values } : {}) }])),
        outcomes: sub?.outcomes ?? ["success"],
        retries: 0,
        agent: {},
        on,
        choices: [],
        ...(rawStep.title !== undefined ? { title: rawStep.title } : {}),
        ...(rawStep.description !== undefined ? { description: rawStep.description } : {}),
        ...conditional,
        ...afterTask,
      });
      continue;
    }
    if (isHandoff) {
      // Gives a job to a singleton playbook of the folder; done once its pipeline takes it.
      for (const field of ["prompt", "outcomes", "silence", "archive_agents", "agent", "choices", "poll"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a hand-off step (the singleton playbook defines it)`);
      }
      if (rawStep.outputs !== undefined) err(`${where}: a hand-off has no outputs: it gives the job to the other playbook and this run does not wait for its result. Remove \`outputs\`, and do not read \`steps.${rawStep.id}.outputs.*\``);
      if (rawStep.on !== undefined) err(`${where}: a hand-off has no \`on\`: it gives the job away and this run does not learn how it ends, so there is nothing to map. Remove \`on\`; the step is done once the pipeline takes the job (the run goes on with its next step, or ends)`);
      if (typeof rawStep.handoff !== "string" && rawStep.handoff!.wait !== undefined) err(`${where}: handoff.wait was removed: a hand-off never waits (it gives the job to the other playbook, and this run goes on). Write \`handoff: { name: ${rawStep.handoff!.name} }\``);
      if (task) err(`${where}: a hand-off cannot be an after-task`);
      const targetId = typeof rawStep.handoff === "string" ? rawStep.handoff : rawStep.handoff!.name;
      let target: Playbook | null = null;
      if (targetId === id || stack.includes(targetId)) {
        err(`${where}: handoff: "${targetId}" leads back to this playbook (${[...stack, id, targetId].join(" → ")}); the runs would hand each other jobs forever`);
      } else if (!folder.ids.has(targetId)) {
        err(`${where}: handoff: playbook "${targetId}" not found in ${folder.relDir}/`);
      } else {
        const loaded = await folder.load(targetId, [...stack, id]);
        target = loaded.entry.playbook;
        if (!target) err(`${where}: handoff: playbook "${targetId}" is invalid: ${loaded.entry.errors[0] ?? "see that file"}`);
        else if (!target.singleton) err(`${where}: handoff: playbook "${targetId}" is not a singleton (add \`singleton: {}\` to it)`);
      }
      if (target?.singleton) handoffs.set(rawStep.id, target);
      const outcomes = target ? (target.outcomes.includes("failure") ? target.outcomes : [...target.outcomes, "failure"]) : ["success", "failure"];
      const on: Record<string, Transition> = {};
      let timeoutMs = defaultTimeout;
      if (rawStep.timeout !== undefined) {
        timeoutMs = parseDuration(rawStep.timeout) ?? undefined;
        if (timeoutMs === undefined) err(`${where}: timeout: expected a duration such as 30m or 2h`);
      }
      steps.push({
        id: rawStep.id,
        kind: "handoff",
        handoff: qualifyId(folder.repo, targetId),
        needs: rawStep.needs,
        prompt: "",
        inputs: {},
        outputs: {},
        outcomes,
        retries: rawStep.retries,
        agent: {},
        on,
        choices: [],
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(rawStep.title !== undefined ? { title: rawStep.title } : {}),
        ...(rawStep.description !== undefined ? { description: rawStep.description } : {}),
        ...(rawStep.short_title !== undefined ? { shortTitle: rawStep.short_title } : {}),
        ...conditional,
      });
      continue;
    }
    if (rawStep.fanout !== undefined) {
      // One run of a playbook of the folder per item of a list; the step joins them.
      for (const field of ["outputs", "outcomes"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a fan-out step (its outcomes and outputs are fixed: see the format reference)`);
      }
      const fan = rawStep.fanout;
      const targetId = fan.playbook;
      let target: Playbook | null = null;
      if (targetId === id || stack.includes(targetId)) {
        err(`${where}: fanout.playbook: "${targetId}" leads back to this playbook (${[...stack, id, targetId].join(" → ")}); a fan-out must not start its own playbook`);
      } else if (!folder.ids.has(targetId)) {
        err(`${where}: fanout.playbook: playbook "${targetId}" not found in ${folder.relDir}/`);
      } else {
        const loaded = await folder.load(targetId, [...stack, id]);
        target = loaded.entry.playbook;
        if (!target) err(`${where}: fanout.playbook: playbook "${targetId}" is invalid: ${loaded.entry.errors[0] ?? "see that file"}`);
        else if (target.singleton) {
          err(`${where}: fanout.playbook: playbook "${targetId}" is a singleton: its runs only come from hand-offs; use \`handoff: { name: ${targetId} }\``);
          target = null;
        }
      }
      const mapped = fan.inputs ?? {};
      if (target) {
        for (const name of Object.keys(mapped)) {
          if (!target.inputs[name]) err(`${where}: fanout.inputs.${name}: playbook "${targetId}" has no input "${name}" (it has: ${Object.keys(target.inputs).join(", ") || "none"})`);
        }
        for (const [name, def] of Object.entries(target.inputs)) {
          if (def.required && def.default === undefined && !(name in mapped)) err(`${where}: fanout.inputs.${name}: playbook "${targetId}" requires input "${name}"; map it, e.g. ${name}: "{{ item }}"`);
        }
      }
      let pool: NonNullable<Step["fanout"]>["pool"];
      const refill = fan.pool?.refill;
      if (refill) {
        const poolId = refill.playbook;
        let passTarget: Playbook | null = null;
        if (poolId === id || stack.includes(poolId)) {
          err(`${where}: fanout.pool.refill.playbook: "${poolId}" leads back to this playbook (${[...stack, id, poolId].join(" → ")}); a refill pass must not start its own playbook`);
        } else if (!folder.ids.has(poolId)) {
          err(`${where}: fanout.pool.refill.playbook: playbook "${poolId}" not found in ${folder.relDir}/`);
        } else {
          const loaded = await folder.load(poolId, [...stack, id]);
          passTarget = loaded.entry.playbook;
          if (!passTarget) err(`${where}: fanout.pool.refill.playbook: playbook "${poolId}" is invalid: ${loaded.entry.errors[0] ?? "see that file"}`);
          else if (passTarget.singleton) {
            err(`${where}: fanout.pool.refill.playbook: playbook "${poolId}" is a singleton: its runs only come from hand-offs`);
            passTarget = null;
          }
        }
        const passInputs = refill.inputs ?? {};
        if (passTarget) {
          for (const name of Object.keys(passInputs)) {
            if (!passTarget.inputs[name]) err(`${where}: fanout.pool.refill.inputs.${name}: playbook "${poolId}" has no input "${name}" (it has: ${Object.keys(passTarget.inputs).join(", ") || "none"})`);
          }
          for (const [name, def] of Object.entries(passTarget.inputs)) {
            if (def.required && def.default === undefined && !(name in passInputs)) err(`${where}: fanout.pool.refill.inputs.${name}: playbook "${poolId}" requires input "${name}"; map it, e.g. ${name}: "{{ pool.done }}"`);
          }
          const out = passTarget.outputs[refill.items_output];
          if (!out) err(`${where}: fanout.pool.refill.items_output: playbook "${poolId}" has no output "${refill.items_output}" (it has: ${Object.keys(passTarget.outputs).join(", ") || "none"}); the pass must output the list of items`);
          else if (out.type !== undefined && out.type !== "list" && out.type !== "string") err(`${where}: fanout.pool.refill.items_output: output "${refill.items_output}" is ${out.type}, not a list`);
        }
        if (!Object.values(passInputs).some((template) => templateRefs(template).some((ref) => ref.startsWith("pool.")))) {
          err(`${where}: fanout.pool.refill.inputs: no input receives the finished keys; map one, e.g. done: "{{ pool.done }}" (values: ${POOL_VALUES.map((value) => `pool.${value}`).join(", ")}). A pass that does not know what is done would list the same items every time`);
        }
        const debounceMs = refill.debounce === undefined ? 0 : parseDuration(refill.debounce);
        if (debounceMs === null) err(`${where}: fanout.pool.refill.debounce: expected a duration such as 30s or 5m`);
        pool = { playbook: qualifyId(folder.repo, poolId), inputs: passInputs, itemsOutput: refill.items_output, after: refill.after, maxRefills: refill.max_refills, debounceMs: debounceMs ?? 0 };
      }
      const outcomeNames = pool ? POOL_OUTCOMES : FANOUT_OUTCOMES;
      const on: Record<string, Transition> = {};
      for (const [outcome, transition] of Object.entries(rawStep.on ?? {})) {
        if (!outcomeNames.includes(outcome)) err(`${where}: on.${outcome}: not an outcome of a fan-out step (${outcomeNames.join(", ")}${pool ? "" : "; `refill_stopped` needs `fanout.pool`"})`);
        if (typeof transition === "string") on[outcome] = { kind: transition };
        else if ("ask" in transition) err(`${where}: on.${outcome}: \`ask\` does not apply to a fan-out step`);
        else if ("end" in transition) on[outcome] = endTransition(`${where}: on.${outcome}`, transition.end);
        else {
          const delayMs = gotoDelay(`${where}: on.${outcome}.delay`, transition.delay);
          on[outcome] = { kind: "goto", target: transition.goto, ...(transition.max_loops !== undefined ? { maxLoops: transition.max_loops } : {}), ...(delayMs !== undefined ? { delayMs } : {}) };
        }
      }
      let timeoutMs = defaultTimeout;
      const timeoutTemplate = rawStep.timeout !== undefined && templateRefs(rawStep.timeout).length > 0 ? rawStep.timeout : undefined;
      if (rawStep.timeout !== undefined && timeoutTemplate === undefined) {
        timeoutMs = parseDuration(rawStep.timeout) ?? undefined;
        if (timeoutMs === undefined) err(`${where}: timeout: expected a duration such as 30m or 2h`);
      }
      steps.push({
        id: rawStep.id,
        kind: "fanout",
        needs: rawStep.needs,
        prompt: "",
        inputs: {},
        outputs: pool ? { ...FANOUT_OUTPUTS, ...POOL_OUTPUTS } : FANOUT_OUTPUTS,
        outcomes: pool ? POOL_OUTCOMES : FANOUT_OUTCOMES,
        retries: rawStep.retries,
        agent: {},
        on,
        choices: [],
        fanout: {
          playbook: qualifyId(folder.repo, targetId),
          items: fan.items,
          inputs: mapped,
          ...(fan.key !== undefined ? { key: fan.key } : {}),
          ...(fan.workspace_name !== undefined ? { workspaceName: fan.workspace_name } : {}),
          maxActive: fan.max_active,
          cancelChildren: fan.cancel_children,
          ...(pool ? { pool } : {}),
        },
        ...((timeoutMs ?? (pool && timeoutTemplate === undefined ? POOL_DEFAULT_TIMEOUT_MS : undefined)) !== undefined ? { timeoutMs: timeoutMs ?? POOL_DEFAULT_TIMEOUT_MS } : {}),
        ...(timeoutTemplate !== undefined ? { timeout: timeoutTemplate } : {}),
        ...(rawStep.title !== undefined ? { title: rawStep.title } : {}),
        ...(rawStep.description !== undefined ? { description: rawStep.description } : {}),
        ...(rawStep.short_title !== undefined ? { shortTitle: rawStep.short_title } : {}),
        ...conditional,
      });
      continue;
    }
    if (isGate) {
      for (const field of ["inputs", "outputs", "outcomes", "timeout"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a gate`);
      }
    }
    let script: string | undefined;
    let pollMs: number | undefined;
    let wakeOn: WakeOn | undefined;
    if (rawStep.wake_on !== undefined) err(`${where}: \`wake_on\` only applies to a script step (under \`script:\`)`);
    if (rawStep.admit !== undefined) err(`${where}: \`admit\` goes under \`queue:\` on a stage of a singleton: write \`queue: { admit: { script: x.sh, poll: 10m } }\``);
    if (scriptStep) {
      const checked = await checkScript(root, scriptStep.run);
      if ("error" in checked) err(`${where}: script.run: ${checked.error}`);
      else script = `${folder.relDir}/scripts/${checked.name}`;
      if (scriptStep.poll !== undefined) {
        pollMs = parseDuration(scriptStep.poll) ?? undefined;
        if (pollMs === undefined) err(`${where}: script.poll: expected a duration such as 30s or 1m`);
      }
      if (scriptStep.wake_on) {
        if (scriptStep.poll === undefined) err(`${where}: script.wake_on needs \`poll\`: events are a hint, the poll is the safety net (write \`script: { run: ${scriptStep.run}, poll: 10m, wake_on: [...] }\`)`);
        wakeOn = checkWakeOn(scriptStep.wake_on, `${where}: script.wake_on`, err);
      }
    }
    const choices: GateChoice[] = Object.entries(gateStep?.choices ?? {}).map(([id, raw]) => {
      if (!ID.test(id)) err(`${where}: gate.choices.${id}: invalid name (lowercase letters, digits, - and _)`);
      const choice: GateChoice = { id, label: raw?.label ?? stepLabel(id.replace(/[_-]+/g, " ")), comment: raw?.comment ?? "none" };
      if (raw?.color) choice.color = raw.color;
      return choice;
    });
    if (gateStep?.choices !== undefined && choices.length === 0) err(`${where}: gate.choices: declare at least one choice`);
    // A script step's non-zero exit is the outcome `failure` whether it declares it or not, so it is always allowed
    // (retries, `on.failure`); agent steps already default to success/failure and hand-offs and fan-outs fix theirs.
    const declared = rawStep.outcomes ?? AGENT_OUTCOMES;
    const outcomes = isGate ? (choices.length > 0 ? choices.map((choice) => choice.id) : GATE_OUTCOMES) : isScript && !declared.includes("failure") ? [...declared, "failure"] : declared;
    const on: Record<string, Transition> = {};
    for (const [outcome, transition] of Object.entries(rawStep.on ?? {})) {
      if (!outcomes.includes(outcome)) err(`${where}: on.${outcome}: not an outcome of this step (${outcomes.join(", ")})`);
      if (typeof transition === "object" && "ask" in transition) {
        if (isGate) err(`${where}: on.${outcome}: \`ask\` only applies to an agent step`);
        const target = transition.goto ?? rawStep.id;
        const maxLoops = transition.max_loops;
        const askChoices: AskChoice[] = Object.entries(transition.choices ?? {}).map(([id, raw]) => {
          const at = `${where}: on.${outcome}.choices.${id}`;
          if (!ID.test(id)) err(`${at}: invalid name (lowercase letters, digits, - and _)`);
          const label = raw?.label ?? stepLabel(id.replace(/[_-]+/g, " "));
          const comment = raw?.comment ?? "required";
          if (raw?.outcome !== undefined) {
            // Ends the step with another outcome: checked against the step's `on` and outputs below.
            if (raw.goto !== undefined || raw.max_loops !== undefined) err(`${at}: \`outcome\` ends the step, so \`goto\` and \`max_loops\` do not apply`);
            const choice: AskChoice = { id, label, comment, target, outcome: raw.outcome, ...(raw.outputs ? { outputs: raw.outputs } : {}) };
            if (raw.color) choice.color = raw.color;
            return choice;
          }
          if (raw?.outputs !== undefined) err(`${at}: \`outputs\` needs an \`outcome\` (a choice without one runs a step again)`);
          const choiceMaxLoops = raw?.max_loops ?? maxLoops;
          const choice: AskChoice = {
            id,
            label,
            comment,
            target: raw?.goto ?? target,
            ...(choiceMaxLoops !== undefined ? { maxLoops: choiceMaxLoops } : {}),
          };
          if (raw?.color) choice.color = raw.color;
          return choice;
        });
        if (transition.choices !== undefined && askChoices.length === 0) err(`${where}: on.${outcome}.choices: declare at least one choice`);
        const askDecider = parseDecider(`${where}: on.${outcome}.decider`, transition.decider);
        on[outcome] = {
          kind: "ask",
          ask: transition.ask,
          target: askChoices[0]?.target ?? target,
          ...(maxLoops !== undefined ? { maxLoops } : {}),
          ...(askChoices.length > 0 ? { choices: askChoices } : {}),
          ...(askDecider ? { decider: askDecider } : {}),
        };
        continue;
      }
      if (typeof transition === "object" && "end" in transition) {
        on[outcome] = endTransition(`${where}: on.${outcome}`, transition.end);
        continue;
      }
      if (typeof transition === "string") {
        on[outcome] = { kind: transition };
        continue;
      }
      if (transition.decider !== undefined && transition.max_loops === undefined) {
        err(`${where}: on.${outcome}.decider: a \`goto\` opens a gate only with \`max_loops\` (its loop-limit gate); add \`max_loops\` or remove \`decider\``);
      }
      const gotoDecider = parseDecider(`${where}: on.${outcome}.decider`, transition.decider);
      const gotoDelayMs = gotoDelay(`${where}: on.${outcome}.delay`, transition.delay);
      on[outcome] = {
        kind: "goto",
        target: transition.goto,
        ...(transition.max_loops !== undefined ? { maxLoops: transition.max_loops } : {}),
        ...(gotoDecider && transition.max_loops !== undefined ? { decider: gotoDecider } : {}),
        ...(gotoDelayMs !== undefined ? { delayMs: gotoDelayMs } : {}),
      };
    }
    // One rule for agent steps and gates: the first outcome completes by default, `failure`
    // (agent steps) retries then fails, every other outcome needs an explicit `on` entry.
    // A gate without `choices` keeps the default Approve / Reject, where `rejected` fails.
    if (!isGate || choices.length > 0) {
      const extra = outcomes.slice(1).filter((outcome) => (isGate || outcome !== "failure") && !on[outcome]);
      const kinds = isGate ? "complete, end, fail or goto" : "complete, end, fail, goto or ask";
      for (const outcome of extra) err(`${where}: ${isGate ? "choice" : "outcome"} "${outcome}" needs an \`on\` entry (${kinds})`);
    }
    const outputs: Record<string, VarDef> = {};
    for (const [name, rawDef] of Object.entries(rawStep.outputs ?? {})) {
      if (!ID.test(name)) err(`${where}: outputs.${name}: invalid name`);
      outputs[name] = toVarDef(rawDef);
      checkVarDef(`${file}: ${where}: outputs.${name}`, outputs[name]!, errors);
    }
    // Ask choices that end the step: a real outcome that does not ask again, and declared outputs.
    for (const [outcome, transition] of Object.entries(on)) {
      if (transition.kind !== "ask") continue;
      for (const choice of transition.choices ?? []) {
        if (choice.outcome === undefined) continue;
        const at = `${where}: on.${outcome}.choices.${choice.id}`;
        const next = on[choice.outcome];
        if (!outcomes.includes(choice.outcome)) err(`${at}: outcome "${choice.outcome}" is not an outcome of this step (${outcomes.join(", ")})`);
        else if (next?.kind === "ask") err(`${at}: outcome "${choice.outcome}" asks again; pick an outcome that completes, ends, fails or loops`);
        for (const name of Object.keys(choice.outputs ?? {})) {
          if (!(name in outputs)) err(`${at}: outputs.${name}: not an output of this step${Object.keys(outputs).length ? ` (${Object.keys(outputs).join(", ")})` : ""}`);
        }
      }
    }
    let timeoutMs = defaultTimeout;
    // A templated timeout is rendered with the step's inputs at each attempt (refs checked in wireStep).
    const timeoutTemplate = rawStep.timeout !== undefined && templateRefs(rawStep.timeout).length > 0 ? rawStep.timeout : undefined;
    if (rawStep.timeout !== undefined && timeoutTemplate === undefined) {
      timeoutMs = parseDuration(rawStep.timeout) ?? undefined;
      if (timeoutMs === undefined) err(`${where}: timeout: expected a duration such as 30m or 2h`);
    }
    let silenceMs = defaultSilence;
    if (roleStep?.silence !== undefined) {
      silenceMs = parseSilence(roleStep.silence) ?? undefined;
      if (silenceMs === undefined) err(`${where}: role.silence: expected a duration such as 30m, or off`);
    }
    const stepRole = roleStep ? roles[roleStep.name] : undefined;
    const autoOutcomes = roleStep?.completion?.auto;
    if (autoOutcomes) {
      if (new Set(autoOutcomes).size !== autoOutcomes.length) err(`${where}: role.completion.auto: duplicate outcome`);
      for (const outcome of autoOutcomes) {
        const kind: string | null = outcomes.includes(outcome) ? (on[outcome] ?? (outcome === "failure" ? { kind: "retry" } : outcome === outcomes[0] || outcome === "success" ? { kind: "complete" } : { kind: "fail" })).kind : null;
        if (kind === null) err(`${where}: role.completion.auto: "${outcome}" is not an outcome of this step (${outcomes.join(", ")})`);
        else if (kind === "retry" || kind === "fail" || kind === "ask") {
          err(`${where}: role.completion.auto: "${outcome}" ${kind === "ask" ? "opens an ask for a human" : "is a failure"}; the plugin only applies outcomes that complete the step, end the flow or loop (a failure or an ask always goes to the manager)`);
        }
      }
    }
    if (rawStep.settle !== undefined && !isGate && !task) {
      const settled = outputs[rawStep.settle.output];
      if (!settled) err(`${where}: settle.output "${rawStep.settle.output}" is not an output of the step (declare it under \`outputs\`)`);
      else if (settled.type !== "string") err(`${where}: settle.output "${rawStep.settle.output}" must be a string output (YAML per job id)`);
    }
    const step: Step = {
      id: rawStep.id,
      kind: isGate ? "gate" : isScript ? "script" : "agent",
      needs: rawStep.needs,
      prompt: roleStep?.prompt ?? "",
      inputs: {},
      outputs,
      outcomes,
      retries: rawStep.retries,
      agent: isGate || isScript ? {} : mergeAgent(defaults.agent, playbookAgent, stepRole?.agent, resolveAgent(roleStep?.agent, tiers, `${where}: role.agent`, err)),
      on,
      choices,
      ...conditional,
      ...afterTask,
    };
    if (rawStep.title !== undefined) step.title = rawStep.title;
    if (rawStep.description !== undefined) step.description = rawStep.description;
    if (rawStep.short_title !== undefined) step.shortTitle = rawStep.short_title;
    if (roleStep) step.role = roleStep.name;
    if (autoOutcomes) step.autoComplete = [...new Set(autoOutcomes)];
    if (gateStep) step.gate = gateStep.question;
    const gateDecider = gateStep ? parseDecider(`${where}: gate.decider`, gateStep.decider) : undefined;
    if (gateDecider) step.decider = gateDecider;
    if (script !== undefined) step.script = script;
    if (pollMs !== undefined) step.pollMs = pollMs;
    if (wakeOn && wakeOn.length > 0) step.wakeOn = wakeOn;
    if (rawStep.settle !== undefined && !isGate && !task) {
      const effects = rawStep.settle.effects ?? {};
      for (const [outcome, effect] of Object.entries(effects)) {
        if (!playbookOutcomes.includes(outcome)) err(`${where}: settle.effects.${outcome}: not an outcome of this playbook (${playbookOutcomes.join(", ")}); declare it in the playbook's \`outcomes\``);
        else if (outcome === playbookOutcomes[0]) err(`${where}: settle.effects.${outcome}: the first outcome is the normal finish (the job leaves the pipeline with all its outputs); it cannot be ${effect}`);
      }
      step.settle = { output: rawStep.settle.output, effects };
    }
    if (timeoutMs !== undefined && !isGate) step.timeoutMs = timeoutMs;
    if (timeoutTemplate !== undefined && !isGate) step.timeout = timeoutTemplate;
    if (silenceMs !== undefined && !isGate && !isScript) step.silenceMs = silenceMs;
    const autoStart = rawStep.manage?.auto_start;
    if (autoStart !== undefined && step.kind !== "agent") err(`${where}: \`manage.auto_start\` only applies to an agent step (the plugin starts scripts, hand-offs and fan-outs itself; a gate is opened with request_gate)`);
    const autoStartResolved = autoStart ?? (step.kind === "agent" ? defaults.manage?.auto_start : undefined);
    if (autoStartResolved === false) step.autoStart = false;
    const notify = rawStep.manage?.notify ?? defaults.manage?.notify;
    if (notify === true && step.kind !== "gate") step.notify = true;
    const archiveAgents = roleStep?.archive_agents ?? defaults.role?.archive_agents;
    if (archiveAgents !== undefined && !isGate && !isScript) step.archiveAgents = archiveAgents;
    steps.push(step);
  }

  // Graph checks. Main steps only need main steps; after-tasks have no needs.
  const ids = new Set(steps.map((step) => step.id));
  const mainSteps = steps.filter((step) => !step.afterTask);
  const mainIds = new Set(mainSteps.map((step) => step.id));
  for (const step of steps) {
    for (const need of step.needs) if (!mainIds.has(need)) err(`step "${step.id}": needs unknown step "${need}"${ids.has(need) ? " (an after-task)" : ""}`);
    if (step.needs.includes(step.id)) err(`step "${step.id}": needs itself`);
  }
  const cycle = findCycle(steps);
  if (cycle) err(`needs form a cycle: ${cycle.join(" → ")}`);
  if (errors.length === 0) {
    const ancestors = new Map(steps.map((step) => [step.id, ancestorsOf(steps, step.id)]));
    for (const step of steps) {
      for (const [outcome, transition] of Object.entries(step.on)) {
        if (transition.kind !== "goto" && transition.kind !== "ask") continue;
        const targets =
          transition.kind === "ask" && transition.choices
            ? transition.choices.map((choice) => ({ where: `on.${outcome}.choices.${choice.id}`, target: choice.target }))
            : [{ where: `on.${outcome}`, target: transition.target }];
        for (const { where, target } of targets) {
          if (!ids.has(target)) err(`step "${step.id}": ${where}: goto unknown step "${target}"`);
          else if (target !== step.id && !ancestors.get(step.id)!.has(target)) {
            err(`step "${step.id}": ${where}: goto "${target}" must point to an earlier step this one needs`);
          }
        }
      }
    }
  }

  // Playbook outputs, from the main steps (after-tasks read them, so they come first).
  const outputs: Playbook["outputs"] = {};
  if (errors.length === 0) {
    for (const [name, rawOutput] of Object.entries(pb.outputs ?? {})) {
      const def = toVarDef(rawOutput);
      checkVarDef(`${file}: outputs.${name}`, def, errors);
      const resolved = resolveOutputSource(name, def.type, rawOutput?.value, mainSteps, inputs);
      // A singleton's outputs are each job's: settle_job gives them, so they need no source.
      if ("error" in resolved && singleton && rawOutput?.value === undefined) outputs[name] = { ...def, source: "", auto: false, label: "settle_job" };
      else if ("error" in resolved) err(`outputs.${name}: ${resolved.error}`);
      else outputs[name] = { ...def, ...resolved };
    }
  }

  // Inputs wiring and prompt references. A playbook step takes the sub-playbook's inputs.
  if (errors.length === 0) {
    const afterContext: AfterContext = { mainIds, outputs };
    for (const step of steps) {
      const raw = rawAll.find((candidate) => candidate.raw.id === step.id)!.raw;
      const sub = blocks.get(step.id);
      const ancestors = ancestorsOf(steps, step.id);
      const after = step.afterTask ? afterContext : undefined;
      const target = handoffs.get(step.id);
      checkStepRefs(step, steps, ancestors, new Set(blocks.keys()), err);
      checkTextRefs(step, ancestors, steps, inputs, err);
      if (sub) wireBlock(step, raw, sub, steps, ancestors, inputs, err, after);
      else if (target) wireBlock(step, raw, target, steps, ancestors, inputs, err, after);
      else wireStep(step, raw, steps, ancestors, inputs, err, new Set(), undefined, after);
      if (step.fanout) checkFanoutRefs(step, err);
    }
  }

  // Expand playbook steps into their sub-playbook's steps, then check the expanded graph.
  let finalSteps = steps;
  const blockInfo: Playbook["blocks"] = {};
  if (errors.length === 0 && blocks.size > 0) {
    const expanded = expandBlocks(steps, blocks, outputs, err);
    finalSteps = expanded.steps;
    Object.assign(blockInfo, expanded.blocks);
    for (const sub of blocks.values()) Object.assign(roles, sub.roles);
  }
  if (errors.length === 0) {
    // Concurrency rule: two steps that may run together must not both edit files. Main steps
    // and after-tasks never run together; after-tasks may run with each other.
    const ancestors = new Map(finalSteps.map((step) => [step.id, ancestorsOf(finalSteps, step.id)]));
    const agents = finalSteps.filter((step) => step.kind === "agent" && step.role && roles[step.role]);
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i]!;
        const b = agents[j]!;
        if (ancestors.get(a.id)!.has(b.id) || ancestors.get(b.id)!.has(a.id)) continue;
        if (Boolean(a.afterTask) !== Boolean(b.afterTask)) continue;
        if (!roles[a.role!]!.readonly && !roles[b.role!]!.readonly) {
          err(`steps "${a.id}" and "${b.id}" can run at the same time and both may edit files; make one role readonly or order them with needs`);
        }
      }
    }
  }

  if (errors.length === 0 && singleton) {
    // Each job's inputs have one value per job: steps read them through {{ run.jobs }}.
    for (const step of finalSteps) {
      for (const [name, wired] of Object.entries(step.inputs)) {
        for (const ref of templateRefs(wired.source)) {
          const input = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(ref)?.[1];
          if (input !== undefined && !keyInputs.has(input)) {
            err(`step "${step.id}": inputs.${name}: "${input}" is each job's input, with one value per job; read it through {{ run.jobs }} in the prompt`);
          }
        }
      }
    }
  }

  // A singleton's top-level steps are stages; `queue` only applies to them.
  const stages: Stage[] = [];
  for (const { raw: rawStep, task } of rawAll) {
    if (rawStep.queue === undefined) continue;
    if (!singleton) err(`step "${rawStep.id}": \`queue\` only applies to a step of a singleton playbook (a stage)`);
    else if (task) err(`after "${rawStep.id}": \`queue\` does not apply to an after-task`);
  }
  if (errors.length === 0 && singleton) {
    const stageIds = new Set(pb.steps.map((raw) => raw.id));
    for (const raw of pb.steps) {
      const own = finalSteps.filter((step) => step.id === raw.id || step.id.startsWith(`${raw.id}.`)).map((step) => step.id);
      const block = blocks.get(raw.id);
      let admit: Stage["admit"];
      const rawAdmit = raw.queue?.admit;
      if (rawAdmit) {
        const where = `step "${raw.id}": queue.admit`;
        const checked = await checkScript(root, rawAdmit.script);
        if ("error" in checked) err(`${where}.script: ${checked.error}`);
        const pollMs = rawAdmit.poll !== undefined ? parseDuration(rawAdmit.poll) : null;
        if (rawAdmit.poll === undefined) err(`${where} needs \`poll\`: events are a hint, the poll is the safety net (write \`queue: { admit: { script: ${rawAdmit.script}, poll: 10m } }\`)`);
        else if (pollMs === null) err(`${where}.poll: expected a duration such as 30s or 10m`);
        const wakeOn = rawAdmit.wake_on ? checkWakeOn(rawAdmit.wake_on, `${where}.wake_on`, err) : [];
        if (!("error" in checked) && pollMs !== null) admit = { script: `${folder.relDir}/scripts/${checked.name}`, pollMs, wakeOn };
      }
      // The effects of the stage's `settle` steps: one meaning per outcome across the stage.
      const effects: Stage["effects"] = {};
      for (const step of finalSteps.filter((candidate) => own.includes(candidate.id) && candidate.settle)) {
        for (const [outcome, effect] of Object.entries(step.settle!.effects)) {
          if (effects[outcome] && effects[outcome] !== effect) err(`step "${step.id}": settle.effects.${outcome}: ${effect}, but another step of stage "${raw.id}" says ${effects[outcome]}; an outcome means one thing per stage`);
          effects[outcome] = effect;
        }
      }
      if (raw.queue?.max_requeues !== undefined && Object.values(effects).every((effect) => effect !== "requeue")) err(`step "${raw.id}": queue.max_requeues: no \`settle.effects\` of this stage declares a \`requeue\` outcome`);
      stages.push({
        id: raw.id,
        effects,
        ...(raw.queue?.max_requeues !== undefined ? { maxRequeues: raw.queue.max_requeues } : {}),
        title: raw.title ?? block?.title ?? stepLabel(raw.id),
        needs: raw.needs,
        mode: raw.queue?.mode ?? "fifo",
        retries: raw.retries,
        steps: own,
        ...(admit ? { admit } : {}),
      });
      // Jobs only move forward: a stage loops only inside itself.
      for (const step of finalSteps.filter((candidate) => own.includes(candidate.id))) {
        for (const [outcome, transition] of Object.entries(step.on)) {
          const targets = transition.kind === "goto" ? [transition.target] : transition.kind === "ask" ? (transition.choices?.map((choice) => choice.target) ?? [transition.target]) : [];
          for (const target of targets) {
            if (!own.includes(target) && stageIds.size > 0) err(`step "${step.id}": on.${outcome}: goto "${target}" leaves stage "${raw.id}"; jobs only move forward between stages`);
          }
        }
      }
    }
    // A batch is its stage alone: its steps cannot read another stage's outputs.
    for (const stage of stages) {
      const own = new Set(stage.steps);
      for (const step of finalSteps.filter((candidate) => own.has(candidate.id))) {
        for (const [name, wired] of Object.entries(step.inputs)) {
          for (const ref of templateRefs(wired.source)) {
            const from = /^steps\.([a-z][a-z0-9_.-]*)\.outputs\./.exec(ref)?.[1];
            if (from !== undefined && !own.has(from)) {
              err(`step "${step.id}": inputs.${name}: reads step "${from}" of another stage; a batch only sees its own stage's steps (pass values between stages as job outputs, with settle_job)`);
            }
          }
        }
      }
    }
    // Batches of different stages share one checkout: no role may edit files.
    for (const step of finalSteps) {
      if (step.kind === "agent" && step.role && roles[step.role] && !roles[step.role]!.readonly) {
        err(`step "${step.id}": role "${step.role}" is not readonly; a singleton's batches share one workspace, so every role it uses must be \`readonly: true\``);
      }
    }
  }

  let isolation = resolveIsolation(pb.isolation, defaults.isolation);
  if (isolation.mode === "worktree" && singleton) {
    // The repository default never reaches a singleton (its batches share one pipeline workspace); asking for it there is an error.
    if (resolveIsolation(pb.isolation, undefined).mode === "worktree") err("`isolation: worktree` does not apply to a singleton: its batches share one pipeline workspace");
    isolation = { ...isolation, mode: "none" };
  }
  if (errors.length > 0) return fail(errors);
  let managerMode: ManagerMode = defaults.managerMode ?? DEFAULT_MANAGER_MODE;
  if (pb.manager?.mode !== undefined) {
    const parsedMode = parseManagerMode(pb.manager.mode);
    if (ManagerModeSchema.safeParse(parsedMode).success) managerMode = parsedMode as ManagerMode;
    else err(`manager.mode: ${parsedMode}`);
  }
  if (managerMode === "none" && singleton) {
    if (pb.manager?.mode !== undefined) err("`manager: { mode: none }` does not apply to a singleton: a pipeline's batches each have a manager");
    managerMode = "always_on";
  }
  if (errors.length > 0) return fail(errors);
  const manager = mergeAgent(defaults.agent?.provider ? { provider: defaults.agent.provider, model: defaults.agent.model } : undefined, defaults.manager);
  entry.playbook = {
    id: qid,
    title: entry.title,
    description: pb.description ?? "",
    file,
    inputs,
    outputs,
    steps: finalSteps,
    roles,
    manager,
    managerCompact: pb.manager?.compact ?? defaults.managerCompact ?? DEFAULT_MANAGER_COMPACT,
    managerMode,
    exhaustedForMs: (defaults.providers?.exhausted_for ? parseDuration(defaults.providers.exhausted_for) : null) ?? DEFAULT_EXHAUSTED_FOR_MS,
    onExhausted: defaults.providers?.on_exhausted ?? "fail",
    maxWaitMs: (defaults.providers?.max_wait ? parseDuration(defaults.providers.max_wait) : null) ?? null,
    fallback: defaults.providers?.fallback ?? [],
    usageCheck: defaults.providers?.usage?.check ?? true,
    usageThreshold: defaults.providers?.usage?.threshold ?? 100,
    slowWarning: { runs: pb.slow_warning?.runs ?? defaults.slow_warning?.runs ?? DEFAULT_SLOW_WARNING.runs, factor: pb.slow_warning?.factor ?? defaults.slow_warning?.factor ?? DEFAULT_SLOW_WARNING.factor },
    managerInstructions: managerInstructions(folder.managerText, qid, pb.manager?.prompt, [...blocks.values()]),
    outcomes: playbookOutcomes,
    workspace: {
      archive: pb.workspace?.archive ?? defaults.workspace?.archive ?? "never",
      keepFailed: pb.workspace?.keep_failed ?? defaults.workspace?.keep_failed ?? true,
    },
    isolation,
    blocks: blockInfo,
    after: (pb.after ?? []).map((raw) => ({
      id: raw.id,
      title: raw.title ?? blocks.get(raw.id)?.title ?? stepLabel(raw.id),
      trigger: raw.trigger,
      steps: finalSteps.filter((step) => step.afterTask === raw.id).map((step) => step.id),
    })),
  };
  if (pb.concurrency !== undefined && !singleton) entry.playbook.concurrency = pb.concurrency;
  if (singleton) entry.playbook.singleton = { ...singleton, stages };
  return { entry };
}

type RawStep = z.infer<typeof RawStepSchema>;
type KindBlocks = {
  role?: z.output<typeof RawRoleStepSchema>;
  gate?: z.output<typeof RawGateStepSchema>;
  script?: z.output<typeof RawScriptStepSchema>;
  playbook?: z.output<typeof RawPlaybookStepSchema>;
};
type Kind = keyof KindBlocks;
const KINDS: Kind[] = ["role", "gate", "script", "playbook"];
/** The required field of each kind's block: what the plain-string form held. */
const KIND_MAIN = { role: "name", gate: "question", script: "run", playbook: "name" } as const;
const KIND_NAMES = { role: "an agent step", gate: "a gate", script: "a script step", playbook: "a playbook step" } as const;

/** A step's kind blocks, with a plain-string kind (refused by refuseFlatForms) read as its block's main field. */
function kindBlocks(raw: RawStep): KindBlocks {
  const blocks: KindBlocks = {};
  for (const kind of KINDS) {
    const value = raw[kind];
    if (value === undefined) continue;
    (blocks as Record<Kind, unknown>)[kind] = typeof value === "string" ? { [KIND_MAIN[kind]]: value } : value;
  }
  return blocks;
}

/** Text placed as-is in a flow map of an error message. */
class Placeholder {
  constructor(readonly text: string) {}
}

/**
 * Refuses the forms from before kind blocks, saying what to write: a plain-string kind
 * (`role: reviewer`), or a kind's field written flat on the step (`poll: 30s`).
 */
function refuseFlatForms(where: string, raw: RawStep, err: (message: string) => void): void {
  const kinds = KINDS.filter((kind) => raw[kind] !== undefined);
  const moved = (Object.keys(MOVED_FIELDS) as MovedField[]).filter((field) => raw[field] !== undefined);
  const flat = (fields: MovedField[]) => Object.fromEntries(fields.map((field) => [field, raw[field]]));
  const reported = new Set<MovedField>();
  for (const kind of kinds) {
    const value = raw[kind];
    if (typeof value !== "string") continue;
    const own = moved.filter((field) => MOVED_FIELDS[field] === kind);
    for (const field of own) reported.add(field);
    err(`${where}: ${kind}: write \`${kind}: ${flowMap({ [KIND_MAIN[kind]]: value, ...flat(own) })}\``);
  }
  const misplaced = moved.filter((field) => !reported.has(field) && kinds.length > 0 && !kinds.includes(MOVED_FIELDS[field]));
  for (const field of misplaced) err(`${where}: \`${field}\` only applies to ${KIND_NAMES[MOVED_FIELDS[field]]} (under \`${MOVED_FIELDS[field]}:\`)`);
  for (const kind of new Set(moved.filter((field) => !reported.has(field) && !misplaced.includes(field)).map((field) => MOVED_FIELDS[field]))) {
    const own = moved.filter((field) => MOVED_FIELDS[field] === kind);
    const block = (raw[kind] ?? {}) as Record<string, unknown>;
    const main = KIND_MAIN[kind];
    const placeholder = new Placeholder(kind === "gate" ? '"…"' : `<${kind === "role" ? "role" : "script"}>`);
    err(`${where}: ${codeList(own)} moved under \`${kind}:\`: write \`${kind}: ${flowMap({ [main]: block[main] ?? placeholder, ...block, ...flat(own) })}\``);
  }
}

/** What an ask choice's `outputs` may read besides `inputs.<name>` and `report.outputs.<name>`. */
const ASK_OUTPUT_REFS = /^(gate\.comment|gate\.choice|report\.summary)$/;

const PROMPT_REFS = /^(worktree|inputs\.[A-Za-z_][\w-]*|run\.id|run\.status|run\.failure|run\.jobs|attempt|loop)$/;

/** The run field to suggest when an after-task input has no source. */
function runExample(name: string): string {
  const field = /^run_(id|status|failure)$/.exec(name);
  return field ? `run.${field[1]}` : "run.id";
}

/** For a prompt that uses a source form (`playbook.inputs.x`, `steps.s.outputs.y`), how to write it. */
function promptHint(ref: string): string {
  const source = parseSourceRef(ref);
  if (!source || source.kind === "run") return "";
  const name = source.kind === "step" ? source.output : source.name;
  const how = source.kind === "playbook" ? `"${name}" (it matches the playbook input by name)` : `${name}: "{{ ${ref} }}"`;
  return `; that is the \`inputs\` form: declare the input in the step's \`inputs\`, e.g. ${how}, and write "{{ inputs.${name} }}" in the prompt`;
}

/** What an after-task's steps may also read: the main steps' outputs and the run's outputs. */
interface AfterContext {
  mainIds: Set<string>;
  outputs: Playbook["outputs"];
}

type SourceRef =
  | { kind: "playbook"; name: string }
  | { kind: "step"; step: string; output: string }
  | { kind: "run"; field: "id" | "status" | "failure" }
  | { kind: "output"; name: string };

/** Why a hand-off has no outputs to read. */
function noOutputsHint(step: Step): string {
  return step.kind === "handoff" ? ` (a hand-off gives the job to another playbook and does not wait for it, so it has no outputs)` : "";
}

function parseSourceRef(ref: string): SourceRef | null {
  const playbook = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(ref);
  if (playbook) return { kind: "playbook", name: playbook[1]! };
  const run = /^run\.(id|status|failure)$/.exec(ref);
  if (run) return { kind: "run", field: run[1] as "id" | "status" | "failure" };
  const output = /^run\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
  if (output) return { kind: "output", name: output[1]! };
  const step = /^steps\.([a-z][a-z0-9_.-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
  if (step) return { kind: "step", step: step[1]!, output: step[2]! };
  return null;
}

function wireStep(
  step: Step,
  raw: z.infer<typeof RawStepSchema>,
  steps: Step[],
  ancestors: Set<string>,
  playbookInputs: Record<string, VarDef>,
  err: (message: string) => void,
  /** Inputs that may stay unwired (a sub-playbook input with a default or not required). */
  optional: Set<string> = new Set(),
  declaredOverride?: Record<string, string | null>,
  /** Set for the steps of an after-task. */
  after?: AfterContext,
): void {
  const where = step.afterTask === step.id ? `after "${step.id}"` : `step "${step.id}"`;
  const declared: Record<string, string | null> =
    declaredOverride ?? (Array.isArray(raw.inputs) ? Object.fromEntries(raw.inputs.map((name) => [name, null])) : raw.inputs ?? {});
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const [name, explicit] of Object.entries(declared)) {
    if (!ID.test(name)) {
      err(`${where}: inputs.${name}: invalid name`);
      continue;
    }
    if (explicit !== null) {
      const refs = templateRefs(explicit);
      let type: VarType | undefined = "string";
      let ok = true;
      for (const ref of refs) {
        const source = parseSourceRef(ref);
        if (!source || (!after && (source.kind === "run" || source.kind === "output"))) {
          const promptForm = /^inputs\.([A-Za-z_][\w-]*)$/.exec(ref);
          const hint = promptForm
            ? `; "{{ inputs.<name> }}" is the prompt form, in \`inputs\` write "{{ playbook.inputs.${promptForm[1]} }}" (or ~ to match by name)`
            : source
              ? "; run.* sources are only for after-tasks"
              : "";
          err(
            `${where}: inputs.${name}: "{{ ${ref} }}" must be playbook.inputs.<name> or steps.<id>.outputs.<name>${after ? ", run.id, run.status, run.failure or run.outputs.<name>" : ""}${hint}`,
          );
          ok = false;
        } else if (source.kind === "playbook" && !playbookInputs[source.name]) {
          err(`${where}: inputs.${name}: playbook input "${source.name}" is not declared`);
          ok = false;
        } else if (source.kind === "output" && !after!.outputs[source.name]) {
          err(`${where}: inputs.${name}: the playbook has no output "${source.name}"`);
          ok = false;
        } else if (source.kind === "step") {
          if (!ancestors.has(source.step) && !after?.mainIds.has(source.step)) {
            err(`${where}: inputs.${name}: step "${source.step}" is not one this step needs (directly or not)`);
            ok = false;
          } else if (!byId.get(source.step)!.outputs[source.output]) {
            err(`${where}: inputs.${name}: step "${source.step}" has no output "${source.output}"${noOutputsHint(byId.get(source.step)!)}`);
            ok = false;
          } else if (!sameWhen(byId.get(source.step)!, step)) {
            err(`${where}: inputs.${name}: step "${source.step}" has a \`when\` and may be skipped (its outputs unset); read it only from a step with the same \`when\``);
            ok = false;
          }
        }
      }
      if (!ok) continue;
      const single = singleRef(explicit);
      if (single) {
        const source = parseSourceRef(single)!;
        type =
          source.kind === "playbook"
            ? playbookInputs[source.name]!.type
            : source.kind === "step"
              ? byId.get(source.step)!.outputs[source.output]!.type
              : source.kind === "output"
                ? after!.outputs[source.name]!.type
                : "string";
      }
      step.inputs[name] = wiring(explicit, false, single ?? "template", type);
      continue;
    }
    const candidates = [...ancestors].filter((id) => byId.get(id)?.outputs[name]);
    if (candidates.length > 1) {
      err(`${where}: input "${name}" matches outputs of several steps (${candidates.sort().join(", ")}); map it explicitly`);
    } else if (candidates.length === 1 && !sameWhen(byId.get(candidates[0]!)!, step)) {
      err(`${where}: input "${name}" matches an output of step "${candidates[0]}", which has a \`when\` and may be skipped (its outputs unset); read it only from a step with the same \`when\``);
    } else if (candidates.length === 1) {
      const source = candidates[0]!;
      step.inputs[name] = wiring(`{{ steps.${source}.outputs.${name} }}`, true, `${source}.${name}`, byId.get(source)!.outputs[name]!.type);
    } else if (after?.outputs[name]) {
      step.inputs[name] = wiring(`{{ run.outputs.${name} }}`, true, `run.outputs.${name}`, after.outputs[name]!.type);
    } else if (playbookInputs[name]) {
      step.inputs[name] = wiring(`{{ playbook.inputs.${name} }}`, true, `playbook.${name}`, playbookInputs[name]!.type);
    } else if (!optional.has(name)) {
      err(
        `${where}: input "${name}" has no source: no earlier step outputs it and the playbook has no such input${after ? ` or output; map it, e.g. ${name}: "{{ ${runExample(name)} }}"` : ""}`,
      );
    }
  }
  for (const ref of templateRefs(step.prompt)) {
    if (!PROMPT_REFS.test(ref)) err(`${where}: prompt uses "{{ ${ref} }}"; prompts may only use inputs.<name>, run.id, run.jobs, worktree, attempt, loop${after ? ", run.status and run.failure" : ""}${promptHint(ref)}`);
    else if (!after && (ref === "run.status" || ref === "run.failure")) {
      err(`${where}: prompt uses "{{ ${ref} }}", which only after-tasks can use (the run is still running in its own steps)`);
    }
    else if (ref.startsWith("inputs.") && !(ref.slice("inputs.".length) in declared)) {
      err(`${where}: prompt uses "{{ ${ref} }}" but the step declares no such input`);
    }
  }
  for (const ref of templateRefs(step.timeout ?? "")) {
    const name = /^inputs\.([A-Za-z_][\w-]*)$/.exec(ref)?.[1];
    if (name === undefined) err(`${where}: timeout uses "{{ ${ref} }}"; a timeout may only use inputs.<name> (a declared input of the step)`);
    else if (!(name in declared)) err(`${where}: timeout uses "{{ ${ref} }}" but the step declares no such input`);
  }
  for (const [outcome, transition] of Object.entries(step.on)) {
    if (transition.kind !== "ask") continue;
    for (const choice of transition.choices ?? []) {
      for (const [name, template] of Object.entries(choice.outputs ?? {})) {
        for (const ref of templateRefs(template)) {
          const input = /^inputs\.([A-Za-z_][\w-]*)$/.exec(ref)?.[1];
          const output = /^report\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref)?.[1];
          const known =
            ASK_OUTPUT_REFS.test(ref) || (input !== undefined && input in declared) || (output !== undefined && output in step.outputs);
          if (!known) {
            err(
              `${where}: on.${outcome}.choices.${choice.id}.outputs.${name} uses "{{ ${ref} }}"; it may use gate.comment, gate.choice, report.summary, report.outputs.<output of this step> and inputs.<declared input>`,
            );
          }
        }
      }
    }
  }
}

/** A fan-out's templates: `items` reads a declared step input; the per-item ones also read `item`, `item.<field>` and `index`. */
function checkFanoutRefs(step: Step, err: (message: string) => void): void {
  const where = `step "${step.id}"`;
  const fan = step.fanout!;
  const check = (at: string, template: string, perItem: boolean) => {
    for (const ref of templateRefs(template)) {
      const input = /^inputs\.([A-Za-z_][\w-]*)$/.exec(ref)?.[1];
      if (input !== undefined) {
        if (!(input in step.inputs)) err(`${where}: ${at} uses "{{ ${ref} }}" but the step declares no such input (declare it under \`inputs\`)`);
      } else if (!perItem || !/^(item(\.[A-Za-z_][\w-]*)?|index)$/.test(ref)) {
        err(`${where}: ${at} uses "{{ ${ref} }}"; ${perItem ? "it may use item, item.<field>, index and inputs.<name>" : "it may only use inputs.<name> (a declared input of the step)"}`);
      }
    }
  };
  check("fanout.items", fan.items, false);
  const source = singleRef(fan.items);
  const sourceInput = source ? /^inputs\.([A-Za-z_][\w-]*)$/.exec(source)?.[1] : undefined;
  if (sourceInput === undefined) err(`${where}: fanout.items must be exactly one reference to a declared input, e.g. "{{ inputs.ready }}" with \`inputs: { ready: "{{ steps.<id>.outputs.<list> }}" }\``);
  else {
    const type = step.inputs[sourceInput]?.type;
    if (type !== undefined && type !== "list" && type !== "string") err(`${where}: fanout.items: input "${sourceInput}" is ${type}, not a list (a \`list\` output or input, or a string holding a JSON array)`);
  }
  for (const [name, template] of Object.entries(fan.inputs)) check(`fanout.inputs.${name}`, template, true);
  if (fan.key !== undefined) check("fanout.key", fan.key, true);
  if (fan.workspaceName !== undefined) check("fanout.workspace_name", fan.workspaceName, true);
  for (const [name, template] of Object.entries(fan.pool?.inputs ?? {})) {
    for (const ref of templateRefs(template)) {
      const input = /^inputs\.([A-Za-z_][\w-]*)$/.exec(ref)?.[1];
      if (input !== undefined) {
        if (!(input in step.inputs)) err(`${where}: fanout.pool.refill.inputs.${name} uses "{{ ${ref} }}" but the step declares no such input (declare it under \`inputs\`)`);
      } else if (!POOL_VALUES.some((value) => ref === `pool.${value}`)) {
        err(`${where}: fanout.pool.refill.inputs.${name} uses "{{ ${ref} }}"; it may use ${POOL_VALUES.map((value) => `pool.${value}`).join(", ")} and inputs.<name>`);
      }
    }
  }
}

/** Wires a playbook step: its inputs are the sub-playbook's inputs, by name or mapped explicitly. */
function wireBlock(
  step: Step,
  raw: z.infer<typeof RawStepSchema>,
  sub: Playbook,
  steps: Step[],
  ancestors: Set<string>,
  playbookInputs: Record<string, VarDef>,
  err: (message: string) => void,
  after?: AfterContext,
): void {
  const where = step.afterTask ? `after "${step.id}"` : `step "${step.id}"`;
  const explicit: Record<string, string | null> = Array.isArray(raw.inputs)
    ? Object.fromEntries(raw.inputs.map((name) => [name, null]))
    : raw.inputs ?? {};
  for (const name of Object.keys(explicit)) {
    if (!sub.inputs[name]) err(`${where}: inputs.${name}: playbook "${sub.id}" has no input "${name}" (it has: ${Object.keys(sub.inputs).join(", ") || "none"})`);
  }
  const declared: Record<string, string | null> = Object.fromEntries(Object.keys(sub.inputs).map((name) => [name, explicit[name] ?? null]));
  const optional = new Set(Object.entries(sub.inputs).filter(([, def]) => def.default !== undefined || !def.required).map(([name]) => name));
  wireStep(step, raw, steps, ancestors, playbookInputs, err, optional, declared, after);
}

/**
 * Replaces each playbook step by its sub-playbook's steps, ids prefixed "<step>.":
 * the block's first steps take its needs, steps that needed the block need its last steps,
 * sources are rewritten (playbook.inputs.* → what the parent wired; steps.<block>.outputs.* →
 * the inner step that produces it), and a goto to the block targets its first step.
 */
function expandBlocks(
  steps: Step[],
  blocks: Map<string, Playbook>,
  outputs: Playbook["outputs"],
  err: (message: string) => void,
): { steps: Step[]; blocks: Playbook["blocks"] } {
  const info: Playbook["blocks"] = {};
  const sinks = new Map<string, string[]>();
  const roots = new Map<string, string[]>();
  // A nested playbook's own after-tasks are ignored: only the outermost playbook's run.
  const mainOf = (sub: Playbook) => sub.steps.filter((step) => !step.afterTask);
  const isAfter = new Set(steps.filter((step) => step.afterTask && blocks.has(step.id)).map((step) => step.id));
  const titles = new Map(steps.flatMap((step) => (blocks.has(step.id) && step.title ? [[step.id, step.title] as const] : [])));
  for (const [blockId, sub] of blocks) {
    const subSteps = mainOf(sub);
    const needed = new Set(subSteps.flatMap((step) => step.needs));
    sinks.set(blockId, subSteps.filter((step) => !needed.has(step.id)).map((step) => `${blockId}.${step.id}`));
    roots.set(blockId, subSteps.filter((step) => step.needs.length === 0).map((step) => `${blockId}.${step.id}`));
    // After-tasks hold no concurrency slot: a sub-playbook used as one has its `concurrency` ignored.
    const limit = !isAfter.has(blockId) && sub.concurrency !== undefined ? { concurrency: sub.concurrency } : {};
    const on = steps.find((step) => step.id === blockId)!.on;
    const routes = Object.keys(on).length > 0 ? { on } : {};
    const outcomes = sub.outcomes.length > 1 ? { outcomes: sub.outcomes } : {};
    info[blockId] = { title: titles.get(blockId) ?? sub.title, playbook: sub.id, ...outcomes, ...routes, ...limit };
    for (const [prefix, nested] of Object.entries(sub.blocks)) {
      if (!subSteps.some((step) => step.id.startsWith(`${prefix}.`))) continue;
      const { concurrency, ...rest } = nested;
      info[`${blockId}.${prefix}`] = isAfter.has(blockId) || concurrency === undefined ? rest : { ...rest, concurrency };
    }
  }
  const mapNeeds = (needs: string[]) => needs.flatMap((need) => sinks.get(need) ?? [need]);
  const outer = (template: string): string =>
    replaceRefs(template, (ref) => {
      const match = /^steps\.([a-z][a-z0-9_.-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
      const sub = match ? blocks.get(match[1]!) : undefined;
      return sub ? inner(match![1]!, sub, sub.outputs[match![2]!]!.source) : null;
    });
  const wiredBy = new Map(steps.filter((step) => blocks.has(step.id)).map((step) => [step.id, step.inputs]));
  const inner = (blockId: string, sub: Playbook, template: string): string =>
    replaceRefs(template, (ref) => {
      const input = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(ref);
      if (input) {
        const wired = wiredBy.get(blockId)?.[input[1]!];
        if (wired) return outer(wired.source);
        const fallback = sub.inputs[input[1]!]?.default;
        return fallback === undefined ? "" : String(fallback);
      }
      const step = /^steps\.([a-z][a-z0-9_.-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
      if (step) return `{{ steps.${blockId}.${step[1]}.outputs.${step[2]} }}`;
      const outcome = /^steps\.([a-z][a-z0-9_.-]*)\.outcome$/.exec(ref);
      return outcome ? `{{ steps.${blockId}.${outcome[1]}.outcome }}` : null;
    });
  const result: Step[] = [];
  for (const step of steps) {
    const sub = blocks.get(step.id);
    if (!sub) {
      const on = Object.fromEntries(
        Object.entries(step.on).map(([outcome, transition]) => [
          outcome,
          mapTargets(transition, (target) => {
            if (!blocks.has(target)) return target;
            const first = roots.get(target)!;
            if (first.length !== 1) {
              err(`step "${step.id}": on.${outcome}: goto "${target}" needs a playbook with a single first step (it has ${first.join(", ")})`);
            }
            return first[0] ?? target;
          }),
        ]),
      );
      const inputs = Object.fromEntries(Object.entries(step.inputs).map(([name, wired]) => [name, { ...wired, source: outer(wired.source) }]));
      const when = step.when?.map((condition) => ({ ...condition, source: outer(condition.source) }));
      const texts = { ...(step.gate !== undefined ? { gate: outer(step.gate) } : {}) };
      for (const transition of Object.values(on)) if (transition.kind === "ask") transition.ask = outer(transition.ask);
      const branch = step.branch && { cases: step.branch.cases.map((candidate) => ({ ...candidate, ...(candidate.when ? { when: candidate.when.map((condition) => ({ ...condition, source: outer(condition.source) })) } : {}) })) };
      result.push({ ...step, needs: mapNeeds(step.needs), inputs, on, ...texts, ...(when ? { when } : {}), ...(branch ? { branch } : {}) });
      continue;
    }
    for (const innerStep of mainOf(sub)) {
      const on = Object.fromEntries(
        Object.entries(innerStep.on).map(([outcome, transition]) => {
          const mapped = mapTargets(transition, (target) => `${step.id}.${target}`);
          return [outcome, mapped.kind === "ask" ? { ...mapped, ask: inner(step.id, sub, mapped.ask) } : mapped];
        }),
      );
      const gate = innerStep.gate !== undefined ? { gate: inner(step.id, sub, innerStep.gate) } : {};
      const inputs = Object.fromEntries(
        Object.entries(innerStep.inputs).map(([name, wired]) => {
          const source = inner(step.id, sub, wired.source);
          const fromParent = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(singleRef(wired.source) ?? "");
          const label = fromParent ? step.inputs[fromParent[1]!]?.label ?? "(default)" : `${step.id}.${wired.label}`;
          return [name, { ...wired, source, label }];
        }),
      );
      // The block's own `when` holds for each of its steps, before theirs (read through the parent's wiring).
      const when = [...(step.when ?? []).map((condition) => ({ ...condition, source: outer(condition.source) })), ...(innerStep.when ?? []).map((condition) => ({ ...condition, source: inner(step.id, sub, condition.source) }))];
      const { when: _innerWhen, branch: innerBranch, ...rest } = innerStep;
      const branch = innerBranch && { cases: innerBranch.cases.map((candidate) => ({ ...candidate, ...(candidate.when ? { when: candidate.when.map((condition) => ({ ...condition, source: inner(step.id, sub, condition.source) })) } : {}) })) };
      result.push({
        ...rest,
        id: `${step.id}.${innerStep.id}`,
        needs: innerStep.needs.length === 0 ? mapNeeds(step.needs) : innerStep.needs.map((need) => `${step.id}.${need}`),
        inputs,
        on,
        ...gate,
        ...(when.length > 0 ? { when } : {}),
        ...(branch ? { branch } : {}),
        ...(step.afterTask ? { afterTask: step.afterTask } : {}),
      });
    }
  }
  for (const [name, output] of Object.entries(outputs)) outputs[name] = { ...output, source: outer(output.source) };
  return { steps: result, blocks: info };
}

/** Whether `test` holds in every state where `other` does (same operand; the same, or fewer, values). */
function sameOrNarrower(other: When, test: When): boolean {
  if (other.source !== test.source || other.input !== test.input) return false;
  if (other.loop || test.loop) return JSON.stringify(other.loop) === JSON.stringify(test.loop);
  if (test.empty !== undefined) return other.empty === test.empty;
  if (other.empty !== undefined) return false;
  return other.values.every((value) => test.values.includes(value));
}

/** Whether a step may read the outputs of `source`: it has no `when`, or the reader has the same one. */
function sameWhen(source: Step, reader: Step): boolean {
  if (!source.when) return true;
  return JSON.stringify(source.when) === JSON.stringify(reader.when ?? []);
}

function wiring(source: string, auto: boolean, label: string, type: VarType | undefined): InputWiring {
  const result: InputWiring = { source, auto, label: label.replace(/^steps\.(.+)\.outputs\./, "$1.").replace(/^playbook\.inputs\./, "playbook.") };
  if (type) result.type = type;
  return result;
}

function resolveOutputSource(
  name: string,
  type: VarType,
  explicit: string | undefined,
  steps: Step[],
  inputs: Record<string, VarDef>,
): { source: string; auto: boolean; label: string } | { error: string } {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (explicit !== undefined) {
    for (const ref of templateRefs(explicit)) {
      const source = parseSourceRef(ref);
      if (!source || source.kind === "run" || source.kind === "output") return { error: `"{{ ${ref} }}" must be playbook.inputs.<name> or steps.<id>.outputs.<name>` };
      if (source.kind === "playbook" && !inputs[source.name]) return { error: `playbook input "${source.name}" is not declared` };
      if (source.kind === "step" && !byId.get(source.step)?.outputs[source.output]) {
        return { error: `step "${source.step}" has no output "${source.output}"${byId.get(source.step) ? noOutputsHint(byId.get(source.step)!) : ""}` };
      }
    }
    const single = singleRef(explicit);
    if (single) {
      const source = parseSourceRef(single)!;
      const fromType = source.kind === "playbook" ? inputs[source.name]!.type : source.kind === "step" ? byId.get(source.step)!.outputs[source.output]!.type : "string";
      if (!typeCompatible(fromType, type)) return { error: `type ${fromType} does not fit ${type}` };
    }
    return { source: explicit, auto: false, label: single ?? "template" };
  }
  const candidates = steps.filter((step) => step.outputs[name] && typeCompatible(step.outputs[name]!.type, type));
  if (candidates.length > 1) return { error: `matches outputs of several steps (${candidates.map((s) => s.id).join(", ")}); set \`value\`` };
  if (candidates.length === 1) {
    return { source: `{{ steps.${candidates[0]!.id}.outputs.${name} }}`, auto: true, label: `${candidates[0]!.id}.${name}` };
  }
  if (inputs[name]) return { source: `{{ playbook.inputs.${name} }}`, auto: true, label: `playbook.${name}` };
  return { error: "no step output or playbook input has this name; set `value`" };
}

/** A transition with its goto targets (an ask's choices' too) passed through `map`. */
function mapTargets(transition: Transition, map: (target: string) => string): Transition {
  if (transition.kind === "goto") return { ...transition, target: map(transition.target) };
  if (transition.kind !== "ask") return transition;
  const choices = transition.choices?.map((choice) => ({ ...choice, target: map(choice.target) }));
  return { ...transition, target: map(transition.target), ...(choices ? { choices } : {}) };
}

/**
 * The step references of a step's conditions (`when`, and each branch case's): the step must be one
 * this step needs (directly or not), which also rules out cycles; an output must exist and each value fit
 * its type; an outcome must be one the step can end with, and a playbook step has none to test.
 */
function checkStepRefs(step: Step, steps: Step[], ancestors: Set<string>, blockIds: Set<string>, err: (message: string) => void): void {
  const byId = new Map(steps.map((candidate) => [candidate.id, candidate]));
  const groups: Array<{ at: string; label: string; conditions: When[] }> = [
    { at: `step "${step.id}"`, label: "when", conditions: step.when ?? [] },
    ...(step.branch?.cases ?? []).map((candidate) => ({ at: `step "${step.id}": branch case "${candidate.name}"`, label: "if", conditions: candidate.when ?? [] })),
  ];
  for (const { at, label, conditions } of groups) {
    for (const condition of conditions) {
      const ref = /^\{\{ steps\.(.+?)\.(?:outputs\.([^.]+)|(outcome)) \}\}$/.exec(condition.source);
      if (!ref) continue;
      const [, id, output] = ref;
      const source = byId.get(id!);
      if (!source) err(`${at}: ${label}.${condition.input}: unknown step "${id}"`);
      else if (id === step.id || !ancestors.has(id!)) {
        err(`${at}: ${label}.${condition.input}: step "${id}" is not one this step needs (directly or not), so its ${output ? "output" : "outcome"} is not known when this one is reached (a condition cannot read a step that runs after it)`);
      } else if (output) {
        const def = source.outputs[output];
        if (!def) err(`${at}: ${label}.${condition.input}: step "${id}" has no output "${output}"${source.outputs && Object.keys(source.outputs).length ? ` (${Object.keys(source.outputs).join(", ")})` : ""}`);
        else for (const value of condition.values) {
          const coerced = coerceValue(def, value);
          if (!coerced.ok) err(`${at}: ${label}.${condition.input}: ${JSON.stringify(value)}: ${coerced.error}`);
        }
      } else if (blockIds.has(source.id)) {
        err(`${at}: ${label}.${condition.input}: step "${id}" is a playbook step, which has no outcome of its own to test; test one of its outputs`);
      } else {
        for (const value of condition.values) {
          if (!source.outcomes.includes(value)) err(`${at}: ${label}.${condition.input}: "${value}" is not an outcome of step "${id}" (${source.outcomes.join(", ")})`);
        }
      }
    }
  }
}

/**
 * The templates of a gate's question and of an `ask` text may read `{{ playbook.inputs.<name> }}` and
 * `{{ steps.<id>.outputs.<name> }}` of a step this one needs; an unset value renders as "(none)".
 */
function checkTextRefs(step: Step, ancestors: Set<string>, steps: Step[], inputs: Record<string, VarDef>, err: (message: string) => void): void {
  const texts: Array<{ at: string; text: string }> = [
    ...(step.gate ? [{ at: "gate.question", text: step.gate }] : []),
    ...Object.entries(step.on).flatMap(([outcome, transition]) => (transition.kind === "ask" ? [{ at: `on.${outcome}.ask`, text: transition.ask }] : [])),
  ];
  const byId = new Map(steps.map((candidate) => [candidate.id, candidate]));
  for (const { at, text } of texts) {
    for (const ref of templateRefs(text)) {
      const where = `step "${step.id}": ${at}: "{{ ${ref} }}"`;
      const source = parseSourceRef(ref);
      if (step.afterTask) err(`${where}: templates in a gate question or ask text do not apply to an after-task`);
      else if (!source || (source.kind !== "playbook" && source.kind !== "step")) err(`${where} must be playbook.inputs.<name> or steps.<id>.outputs.<name>`);
      else if (source.kind === "playbook" && !inputs[source.name]) err(`${where}: playbook input "${source.name}" is not declared`);
      else if (source.kind === "step") {
        if (!ancestors.has(source.step)) err(`${where}: step "${source.step}" is not one this step needs (directly or not)`);
        else if (!byId.get(source.step)!.outputs[source.output]) err(`${where}: step "${source.step}" has no output "${source.output}"`);
      }
    }
  }
}
