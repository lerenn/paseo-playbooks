import { access, constants, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_GATE_CHOICES } from "../shared/gates";
import { ancestorsOf, findCycle } from "../shared/graph";
import { stepLabel } from "../shared/labels";
import type {
  AskChoice,
  GateChoice,
  GateDecider,
  AgentSettings,
  ManagerCompact,
  InputWiring,
  Playbook,
  PlaybookEntry,
  Role,
  Step,
  Transition,
  VarDef,
  VarType,
  Station,
  VarValue,
  When,
} from "../shared/types";
import { AgentSettingsSchema, DEFAULT_EXHAUSTED_FOR_MS, DEFAULT_MANAGER_COMPACT, ManagerCompactSchema, type Isolation, VarTypeSchema, VarValueSchema } from "../shared/types";
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
  z.object({ goto: z.string(), max_loops: z.number().int().positive().optional(), decider: RawDeciderSchema.optional() }),
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

/** A script step: an executable in the folder's scripts/, run by the plugin itself. */
const RawScriptStepSchema = z
  .object({
    run: z.string().min(1),
    /** Rerun the script this often while it exits with SCRIPT_NOT_YET (`30s`, `1m`). */
    poll: z.string().optional(),
  })
  .strict();

/** A sub-playbook from the same folder, run in place of this step. */
const RawPlaybookStepSchema = z.object({ name: z.string().min(1) }).strict();

/** A hand-off: a singleton playbook from the same folder, given a job; the step waits for its result. */
const RawHandoffStepSchema = z
  .object({
    name: z.string().min(1),
    /** false: the step completes with the first outcome as soon as the pipeline takes the job, and the job no longer belongs to this run. Default true. */
    wait: z.boolean().default(true),
  })
  .strict();

/** Fields that moved into a kind's block; read flat only to refuse them with the new form. */
const MOVED_FIELDS = { prompt: "role", silence: "role", archive_agents: "role", agent: "role", choices: "gate", poll: "script" } as const;
type MovedField = keyof typeof MOVED_FIELDS;

const RawStepSchema = z.object({
    id: z.string(),
    /** Full name (details panel, graph); on a playbook step, the block's frame. Default: the id, capitalised. */
    title: z.string().min(1).optional(),
    /** Name in the Playbooks screen columns. Default: the title. */
    short_title: z.string().min(1).optional(),
    needs: z.array(z.string()).default([]),
    role: kindBlock(RawRoleStepSchema).optional(),
    gate: kindBlock(RawGateStepSchema).optional(),
    playbook: kindBlock(RawPlaybookStepSchema).optional(),
    script: kindBlock(RawScriptStepSchema).optional(),
    handoff: kindBlock(RawHandoffStepSchema).optional(),
    /** A singleton's station: which waiting jobs a train takes. */
    queue: z
      .object({
        /** fifo: the oldest waiting job alone; merge: every waiting job. */
        mode: z.enum(["fifo", "merge"]).default("fifo"),
      })
      .strict()
      .optional(),
    /** On a train of a singleton pipeline: the plugin settles the train's jobs from one of the step's outputs. */
    settle: z
      .object({
        /** A string output holding YAML: per job id, `outputs` and, for a job that ends now, `outcome` (and `reason`). */
        output: z.string(),
      })
      .strict()
      .optional(),
    /** Runs the step only for these input values (one value or a list per input); otherwise it is skipped. */
    when: z.record(z.string(), z.union([RawScalarSchema, z.array(RawScalarSchema).min(1)])).optional(),
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

/** A playbook's isolation over the defaults': the playbook's own fields win, field by field. */
function resolveIsolation(own: RawIsolation | undefined, fallback: RawIsolation | undefined): Isolation {
  const fields = (raw: RawIsolation | undefined) => (typeof raw === "string" ? { mode: raw } : (raw ?? {}));
  const merged = { ...fields(fallback), ...fields(own) } as { mode?: Isolation["mode"]; submodules?: Isolation["submodules"]; base?: string; allow_gitlink_removal?: boolean };
  return { mode: merged.mode ?? "none", submodules: merged.submodules ?? "none", base: merged.base ?? null, allowGitlinkRemoval: merged.allow_gitlink_removal ?? false };
}

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
            /** Removed in favour of stations; read only to refuse it. */
            concurrency: z.unknown().optional(),
          })
          .strict(),
      ])
      .optional(),
    /** How the playbook can end, for a parent that uses it as a sub-playbook. The first is a normal finish. */
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
    manager: RawAgentSchema.extend({ compact: ManagerCompactSchema.optional() }).optional(),
    workspace: RawWorkspaceSchema.optional(),
    isolation: RawIsolationSchema.optional(),
    /** Provider failover (a tier listing several targets). */
    providers: z
      .object({
        /** How long a `provider/model` that ran out of tokens is skipped before it is tried again (`1h`). Default 1h. */
        exhausted_for: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Reload agent sessions that hold the tools of an older plugin generation once idle. Default true. */
    reload_stale_sessions: z.boolean().optional(),
    timeout: z.string().optional(),
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
type RawDefaults = Omit<z.infer<typeof RawDefaultsSchema>, "tiers"> & { tiers?: Tiers; managerCompact?: ManagerCompact };

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
    const { compact, ...settings } = parsed.data.manager;
    defaults.manager = resolveAgent(settings, tiers, "manager", fail);
    if (compact !== undefined) defaults.managerCompact = compact;
  }
  if (parsed.data.timeout && parseDuration(parsed.data.timeout) === null) {
    errors.push(`${rel}: timeout: expected a duration such as 30m or 2h`);
  }
  if (parsed.data.providers?.exhausted_for !== undefined && parseDuration(parsed.data.providers.exhausted_for) === null) {
    errors.push(`${rel}: providers.exhausted_for: expected a duration such as 30m or 2h`);
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
}

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
}

const NO_SIDEKICK: SidekickLoad = { configured: false, dir: null, config: null, instructions: null, errors: [] };

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
    let config: SidekickConfig = { watch: DEFAULT_SIDEKICK_WATCH };
    if ((await readText(path.join(dir, "sidekick.yaml"))) !== null) {
      const raw = await readYaml(path.join(dir, "sidekick.yaml"), `${rel}/sidekick.yaml`);
      if ("error" in raw) errors.push(raw.error);
      else {
        const parsed = RawSidekickSchema.safeParse(raw.value);
        if (!parsed.success) errors.push(...formatZodError(`${rel}/sidekick.yaml`, parsed.error));
        else {
          const { watch, ...settings } = parsed.data.sidekick ?? {};
          config = { ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)), watch: watch ?? DEFAULT_SIDEKICK_WATCH };
        }
      }
    }
    let instructions: string | null = null;
    const text = await readText(path.join(dir, "instructions.md"));
    if (text !== null) {
      if (text.trim() === "") errors.push(`${rel}/instructions.md: empty`);
      else instructions = text.trim();
    }
    return { configured: true, dir: rel, config: errors.length > 0 ? null : config, instructions, errors };
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

/**
 * Loads and validates every playbook in `.paseo/plugins/playbooks/` and `.paseo/playbooks/`.
 * Each folder uses its own roles/ and defaults/; the same playbook id in both is an error.
 */
export async function loadPlaybooks(workspaceDir: string): Promise<LoadResult> {
  const roots: string[] = [];
  const entries: PlaybookEntry[] = [];
  for (const relDir of PLAYBOOKS_DIRS) {
    const root = path.join(workspaceDir, relDir);
    const names = await listFolder(root);
    if (names === null) continue;
    roots.push(root);
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
  }
  for (const entry of entries) {
    const clashes = entries.filter((other) => other !== entry && other.id === entry.id);
    if (clashes.length === 0) continue;
    entry.errors.push(`${entry.file}: playbook id "${entry.id}" is also defined in ${clashes.map((other) => other.file).join(", ")}; rename one`);
    entry.playbook = null;
  }
  return { roots, exists: roots.length > 0, entries, sidekick: await loadSidekick(workspaceDir) };
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
  defaults: RawDefaults;
  /** `defaults/manager.md`, trimmed. */
  managerText: string | null;
  role: (id: string) => Promise<RoleLoad>;
  ids: Set<string>;
  /** `stack` holds the playbooks being expanded above this one, to refuse self-inclusion. */
  load: (id: string, stack: string[]) => Promise<Loaded>;
}

type Loaded = { entry: PlaybookEntry };

async function loadPlaybook(folder: Folder, name: string, file: string, id: string, stack: string[]): Promise<Loaded> {
  const { root, defaults, role } = folder;
  const entry: PlaybookEntry = { id, file, title: id, hidden: false, errors: [], playbook: null };
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
    singleton = { stations: [] };
    if (raw.branch !== undefined) singleton.branch = raw.branch;
    if (raw.concurrency !== undefined) {
      err("singleton.concurrency was removed: each top-level step is a station with its own waiting list; set `queue: { mode: fifo | merge }` on a step instead");
    }
    if (pb.concurrency !== undefined) err("`concurrency` does not apply to a singleton playbook: each top-level step is a station, which runs one train at a time");
    if (pb.after !== undefined) err("`after` does not apply to a singleton playbook (its pipeline never ends)");
  }
  // A singleton has no run inputs: every input is each job's.
  const keyInputs = new Set<string>();

  /** A step's `when`: each input must exist (a key input on a singleton) and each value fit its type. */
  const parseWhen = (where: string, raw: Record<string, VarValue | VarValue[]> | undefined): When[] | undefined => {
    if (raw === undefined) return undefined;
    const conditions: When[] = [];
    for (const [name, given] of Object.entries(raw)) {
      const def = inputs[name];
      if (name === "loop" && !def) {
        const tests: NonNullable<When["loop"]> = [];
        for (const value of Array.isArray(given) ? given : [given]) {
          const match = /^\s*(==|=|>=|<=|>|<)?\s*(\d+)\s*$/.exec(String(value));
          if (match) tests.push({ op: match[1] === undefined || match[1] === "=" ? "==" : (match[1] as "==" | ">=" | "<=" | ">" | "<"), value: Number(match[2]) });
          else err(`${where}: when.loop: ${JSON.stringify(value)}: expected a loop count such as 1, ">=2" or "<3"`);
        }
        if (tests.length > 0) conditions.push({ input: "loop", source: "", values: [], loop: tests });
        continue;
      }
      if (!def) {
        err(`${where}: when.${name}: not an input of this playbook${Object.keys(inputs).length ? ` (${Object.keys(inputs).join(", ")})` : ""}`);
        continue;
      }
      if (singleton && !keyInputs.has(name)) {
        err(`${where}: when.${name}: a singleton's inputs are each job's, so \`when\` cannot use them; put the condition in the station's sub-playbook, on an input the station sets`);
        continue;
      }
      const values: string[] = [];
      for (const value of Array.isArray(given) ? given : [given]) {
        const coerced = coerceValue(def, value);
        if (coerced.ok) values.push(String(coerced.value));
        else err(`${where}: when.${name}: ${JSON.stringify(value)}: ${coerced.error}`);
      }
      conditions.push({ input: name, source: `{{ playbook.inputs.${name} }}`, values });
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
    if ([roleStep, gateStep, playbookStep, scriptStep, rawStep.handoff].filter((value) => value !== undefined).length !== 1) {
      err(`${where}: set exactly one of \`role\`, \`gate\`, \`playbook\`, \`script\` or \`handoff\``);
    }
    refuseFlatForms(where, rawStep, err);
    if (typeof rawStep.handoff === "string") err(`${where}: handoff: write \`handoff: { name: ${rawStep.handoff} }\``);
    if (task && rawStep.when !== undefined) err(`${where}: \`when\` does not apply to an after-task`);
    if (rawStep.when && "loop" in rawStep.when && !inputs.loop && kindBlocks(rawStep).playbook !== undefined) {
      err(`${where}: when.loop does not apply to a playbook step (it has no loop count); put it on a step of the sub-playbook`);
    }
    const when = task ? undefined : parseWhen(where, rawStep.when);
    const conditional = when ? { when } : {};
    if (rawStep.settle !== undefined && (isGate || isBlock || isHandoff || task)) {
      err(`${where}: \`settle\` only applies to a role or script step (its outputs settle the train's jobs)`);
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
        ...conditional,
        ...afterTask,
      });
      continue;
    }
    if (isHandoff) {
      // Hands a job to a singleton playbook of the folder and waits for its result.
      for (const field of ["prompt", "outputs", "outcomes", "silence", "archive_agents", "agent", "choices", "poll"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a hand-off step (the singleton playbook defines it)`);
      }
      if (task) err(`${where}: a hand-off cannot be an after-task`);
      const targetId = typeof rawStep.handoff === "string" ? rawStep.handoff : rawStep.handoff!.name;
      let target: Playbook | null = null;
      if (targetId === id || stack.includes(targetId)) {
        err(`${where}: handoff: "${targetId}" leads back to this playbook (${[...stack, id, targetId].join(" → ")}); the runs would wait on each other`);
      } else if (!folder.ids.has(targetId)) {
        err(`${where}: handoff: playbook "${targetId}" not found in ${folder.relDir}/`);
      } else {
        const loaded = await folder.load(targetId, [...stack, id]);
        target = loaded.entry.playbook;
        if (!target) err(`${where}: handoff: playbook "${targetId}" is invalid: ${loaded.entry.errors[0] ?? "see that file"}`);
        else if (!target.singleton) err(`${where}: handoff: playbook "${targetId}" is not a singleton (add \`singleton: {}\` to it)`);
      }
      if (target?.singleton) handoffs.set(rawStep.id, target);
      const wait = typeof rawStep.handoff === "string" || rawStep.handoff!.wait;
      const outcomes = target ? (target.outcomes.includes("failure") ? target.outcomes : [...target.outcomes, "failure"]) : ["success", "failure"];
      const on: Record<string, Transition> = {};
      for (const [outcome, transition] of Object.entries(rawStep.on ?? {})) {
        if (target && !outcomes.includes(outcome)) err(`${where}: on.${outcome}: not an outcome of playbook "${targetId}" (${target.outcomes.join(", ")})`);
        if (typeof transition === "string") on[outcome] = { kind: transition };
        else if ("ask" in transition) err(`${where}: on.${outcome}: \`ask\` does not apply to a hand-off step`);
        else if ("end" in transition) on[outcome] = endTransition(`${where}: on.${outcome}`, transition.end);
        else on[outcome] = transition.max_loops !== undefined ? { kind: "goto", target: transition.goto, maxLoops: transition.max_loops } : { kind: "goto", target: transition.goto };
      }
      if (!wait) {
        // Done once the job is in the pipeline: only the first outcome, or failure to hand it off.
        for (const outcome of Object.keys(on)) {
          if (outcome !== outcomes[0] && outcome !== "failure") err(`${where}: on.${outcome}: a hand-off with \`wait: false\` only ends with "${outcomes[0]}" (or "failure" if the job cannot be handed off)`);
        }
      } else if (target) {
        for (const outcome of target.outcomes.slice(1)) {
          if (outcome !== "failure" && !on[outcome]) err(`${where}: outcome "${outcome}" of playbook "${targetId}" needs an \`on\` entry (complete, end, fail or goto)`);
        }
      }
      let timeoutMs = defaultTimeout;
      if (rawStep.timeout !== undefined) {
        timeoutMs = parseDuration(rawStep.timeout) ?? undefined;
        if (timeoutMs === undefined) err(`${where}: timeout: expected a duration such as 30m or 2h`);
      }
      steps.push({
        id: rawStep.id,
        kind: "handoff",
        handoff: targetId,
        ...(wait ? {} : { handoffWait: false as const }),
        needs: rawStep.needs,
        prompt: "",
        inputs: {},
        // Without waiting, the step never sees the job's outputs.
        outputs: !wait ? {} : Object.fromEntries(Object.entries(target?.outputs ?? {}).map(([name, def]) => [name, { type: def.type, ...(def.values ? { values: def.values } : {}) }])),
        outcomes,
        retries: rawStep.retries,
        agent: {},
        on,
        choices: [],
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(rawStep.title !== undefined ? { title: rawStep.title } : {}),
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
    if (scriptStep) {
      const checked = await checkScript(root, scriptStep.run);
      if ("error" in checked) err(`${where}: script.run: ${checked.error}`);
      else script = `${folder.relDir}/scripts/${checked.name}`;
      if (scriptStep.poll !== undefined) {
        pollMs = parseDuration(scriptStep.poll) ?? undefined;
        if (pollMs === undefined) err(`${where}: script.poll: expected a duration such as 30s or 1m`);
      }
    }
    const choices: GateChoice[] = Object.entries(gateStep?.choices ?? {}).map(([id, raw]) => {
      if (!ID.test(id)) err(`${where}: gate.choices.${id}: invalid name (lowercase letters, digits, - and _)`);
      const choice: GateChoice = { id, label: raw?.label ?? stepLabel(id.replace(/[_-]+/g, " ")), comment: raw?.comment ?? "none" };
      if (raw?.color) choice.color = raw.color;
      return choice;
    });
    if (gateStep?.choices !== undefined && choices.length === 0) err(`${where}: gate.choices: declare at least one choice`);
    const outcomes = isGate ? (choices.length > 0 ? choices.map((choice) => choice.id) : GATE_OUTCOMES) : rawStep.outcomes ?? AGENT_OUTCOMES;
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
      on[outcome] = {
        kind: "goto",
        target: transition.goto,
        ...(transition.max_loops !== undefined ? { maxLoops: transition.max_loops } : {}),
        ...(gotoDecider && transition.max_loops !== undefined ? { decider: gotoDecider } : {}),
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
    if (rawStep.short_title !== undefined) step.shortTitle = rawStep.short_title;
    if (roleStep) step.role = roleStep.name;
    if (gateStep) step.gate = gateStep.question;
    const gateDecider = gateStep ? parseDecider(`${where}: gate.decider`, gateStep.decider) : undefined;
    if (gateDecider) step.decider = gateDecider;
    if (script !== undefined) step.script = script;
    if (pollMs !== undefined) step.pollMs = pollMs;
    if (rawStep.settle !== undefined && !isGate && !task) step.settle = { output: rawStep.settle.output };
    if (timeoutMs !== undefined && !isGate) step.timeoutMs = timeoutMs;
    if (timeoutTemplate !== undefined && !isGate) step.timeout = timeoutTemplate;
    if (silenceMs !== undefined && !isGate && !isScript) step.silenceMs = silenceMs;
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
      if (sub) wireBlock(step, raw, sub, steps, ancestors, inputs, err, after);
      else if (target) wireBlock(step, raw, target, steps, ancestors, inputs, err, after);
      else wireStep(step, raw, steps, ancestors, inputs, err, new Set(), undefined, after);
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

  // A singleton's top-level steps are stations; `queue` only applies to them.
  const stations: Station[] = [];
  for (const { raw: rawStep, task } of rawAll) {
    if (rawStep.queue === undefined) continue;
    if (!singleton) err(`step "${rawStep.id}": \`queue\` only applies to a step of a singleton playbook (a station)`);
    else if (task) err(`after "${rawStep.id}": \`queue\` does not apply to an after-task`);
  }
  if (errors.length === 0 && singleton) {
    const stationIds = new Set(pb.steps.map((raw) => raw.id));
    for (const raw of pb.steps) {
      const own = finalSteps.filter((step) => step.id === raw.id || step.id.startsWith(`${raw.id}.`)).map((step) => step.id);
      const block = blocks.get(raw.id);
      stations.push({
        id: raw.id,
        title: raw.title ?? block?.title ?? stepLabel(raw.id),
        needs: raw.needs,
        mode: raw.queue?.mode ?? "fifo",
        retries: raw.retries,
        steps: own,
      });
      // Jobs only move forward: a station loops only inside itself.
      for (const step of finalSteps.filter((candidate) => own.includes(candidate.id))) {
        for (const [outcome, transition] of Object.entries(step.on)) {
          const targets = transition.kind === "goto" ? [transition.target] : transition.kind === "ask" ? (transition.choices?.map((choice) => choice.target) ?? [transition.target]) : [];
          for (const target of targets) {
            if (!own.includes(target) && stationIds.size > 0) err(`step "${step.id}": on.${outcome}: goto "${target}" leaves station "${raw.id}"; jobs only move forward between stations`);
          }
        }
      }
    }
    // A train is its station alone: its steps cannot read another station's outputs.
    for (const station of stations) {
      const own = new Set(station.steps);
      for (const step of finalSteps.filter((candidate) => own.has(candidate.id))) {
        for (const [name, wired] of Object.entries(step.inputs)) {
          for (const ref of templateRefs(wired.source)) {
            const from = /^steps\.([a-z][a-z0-9_.-]*)\.outputs\./.exec(ref)?.[1];
            if (from !== undefined && !own.has(from)) {
              err(`step "${step.id}": inputs.${name}: reads step "${from}" of another station; a train only sees its own station's steps (pass values between stations as job outputs, with settle_job)`);
            }
          }
        }
      }
    }
    // Trains of different stations share one checkout: no role may edit files.
    for (const step of finalSteps) {
      if (step.kind === "agent" && step.role && roles[step.role] && !roles[step.role]!.readonly) {
        err(`step "${step.id}": role "${step.role}" is not readonly; a singleton's trains share one workspace, so every role it uses must be \`readonly: true\``);
      }
    }
  }

  let isolation = resolveIsolation(pb.isolation, defaults.isolation);
  if (isolation.mode === "worktree" && singleton) {
    // The repository default never reaches a singleton (its trains share one pipeline workspace); asking for it there is an error.
    if (resolveIsolation(pb.isolation, undefined).mode === "worktree") err("`isolation: worktree` does not apply to a singleton: its trains share one pipeline workspace");
    isolation = { ...isolation, mode: "none" };
  }
  if (errors.length > 0) return fail(errors);
  const manager = mergeAgent(defaults.agent?.provider ? { provider: defaults.agent.provider, model: defaults.agent.model } : undefined, defaults.manager);
  entry.playbook = {
    id,
    title: entry.title,
    description: pb.description ?? "",
    file,
    inputs,
    outputs,
    steps: finalSteps,
    roles,
    manager,
    managerCompact: pb.manager?.compact ?? defaults.managerCompact ?? DEFAULT_MANAGER_COMPACT,
    exhaustedForMs: (defaults.providers?.exhausted_for ? parseDuration(defaults.providers.exhausted_for) : null) ?? DEFAULT_EXHAUSTED_FOR_MS,
    managerInstructions: managerInstructions(folder.managerText, id, pb.manager?.prompt, [...blocks.values()]),
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
  if (singleton) entry.playbook.singleton = { ...singleton, stations };
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

/** Why a hand-off that does not wait has no outputs to read. */
function noOutputsHint(step: Step): string {
  return step.kind === "handoff" && step.handoffWait === false ? ` (a hand-off with \`wait: false\` does not wait for its job, so it gives no outputs)` : "";
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
      return step ? `{{ steps.${blockId}.${step[1]}.outputs.${step[2]} }}` : null;
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
      result.push({ ...step, needs: mapNeeds(step.needs), inputs, on });
      continue;
    }
    for (const innerStep of mainOf(sub)) {
      const on = Object.fromEntries(
        Object.entries(innerStep.on).map(([outcome, transition]) => [outcome, mapTargets(transition, (target) => `${step.id}.${target}`)]),
      );
      const inputs = Object.fromEntries(
        Object.entries(innerStep.inputs).map(([name, wired]) => {
          const source = inner(step.id, sub, wired.source);
          const fromParent = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(singleRef(wired.source) ?? "");
          const label = fromParent ? step.inputs[fromParent[1]!]?.label ?? "(default)" : `${step.id}.${wired.label}`;
          return [name, { ...wired, source, label }];
        }),
      );
      // The block's own `when` holds for each of its steps, before theirs (read through the parent's wiring).
      const when = [...(step.when ?? []), ...(innerStep.when ?? []).map((condition) => ({ ...condition, source: inner(step.id, sub, condition.source) }))];
      const { when: _innerWhen, ...rest } = innerStep;
      result.push({
        ...rest,
        id: `${step.id}.${innerStep.id}`,
        needs: innerStep.needs.length === 0 ? mapNeeds(step.needs) : innerStep.needs.map((need) => `${step.id}.${need}`),
        inputs,
        on,
        ...(when.length > 0 ? { when } : {}),
        ...(step.afterTask ? { afterTask: step.afterTask } : {}),
      });
    }
  }
  for (const [name, output] of Object.entries(outputs)) outputs[name] = { ...output, source: outer(output.source) };
  return { steps: result, blocks: info };
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
