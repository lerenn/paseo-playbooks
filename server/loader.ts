import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_GATE_CHOICES } from "../shared/gates";
import { ancestorsOf, findCycle } from "../shared/graph";
import { stepLabel } from "../shared/labels";
import type {
  GateChoice,
  AgentSettings,
  InputWiring,
  Playbook,
  PlaybookEntry,
  Role,
  Step,
  Transition,
  VarDef,
  VarType,
} from "../shared/types";
import { AgentSettingsSchema, VarTypeSchema, VarValueSchema } from "../shared/types";
import { parseDuration, replaceRefs, singleRef, templateRefs, typeCompatible } from "../shared/vars";

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

const RawTransitionSchema = z.union([
  z.enum(["complete", "end", "fail"]),
  /** Ask a human (gate with a required comment), then go back to `goto` (default: this step) with the answer. */
  z.object({ ask: z.string().min(1), goto: z.string().optional(), max_loops: z.number().int().positive().optional() }),
  z.object({ goto: z.string(), max_loops: z.number().int().positive().optional() }),
]);

const RawStepSchema = z.object({
    id: z.string(),
    needs: z.array(z.string()).default([]),
    role: z.string().optional(),
    gate: z.string().optional(),
    /** A sub-playbook from the same folder, run in place of this step. */
    playbook: z.string().optional(),
    prompt: z.string().optional(),
    inputs: z.union([z.array(z.string()), z.record(z.string(), z.string().nullable())]).optional(),
    outputs: z.record(z.string(), RawVarDefSchema.nullable()).optional(),
    outcomes: z.array(z.string()).min(1).optional(),
    retries: z.number().int().min(0).default(0),
    timeout: z.string().optional(),
    agent: AgentSettingsSchema.optional(),
    on: z.record(z.string(), RawTransitionSchema).optional(),
    /** Gates only: the buttons, in order. Keys are the outcomes; the first one continues by default. */
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
    /** Only on after-tasks; read here to refuse it on a step. */
    trigger: z.unknown().optional(),
  });

/** An after-task: a step (role, gate or playbook) with a trigger and no needs. */
const RawAfterSchema = RawStepSchema.extend({
    title: z.string().optional(),
    trigger: z.enum(["auto", "manual"]).default("auto"),
    /** Refused: each after-task starts on its own. */
    needs: z.unknown().optional(),
  });

const RawPlaybookSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    agent: AgentSettingsSchema.optional(),
    inputs: z.record(z.string(), RawVarDefSchema.nullable()).optional(),
    outputs: z.record(z.string(), RawOutputSchema.nullable()).optional(),
    /** Removed: playbooks compose only as sub-playbook steps. Kept here to refuse it clearly. */
    next: z.unknown().optional(),
    concurrency: z.number().int().positive().optional(),
    steps: z.array(RawStepSchema).min(1),
    /** Tasks run once the main graph ends (completed or failed); they never change the run's status. */
    after: z.array(RawAfterSchema).optional(),
  });

const RawRoleSchema = z.object({
    title: z.string().optional(),
    readonly: z.boolean().default(false),
    agent: AgentSettingsSchema.optional(),
  });

const RawDefaultsSchema = z.object({
    agent: AgentSettingsSchema.optional(),
    manager: AgentSettingsSchema.optional(),
    timeout: z.string().optional(),
  });
type RawDefaults = z.infer<typeof RawDefaultsSchema>;

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
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (merged as Record<string, string>)[key] = value;
    }
  }
  return merged;
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

async function loadRole(root: string, relDir: string, id: string): Promise<RoleLoad> {
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
  if (errors.length > 0) return { role: null, errors };
  return {
    role: {
      id,
      title: parsed.data.title ?? id,
      readonly: parsed.data.readonly,
      instructions: instructions.trim(),
      agent: parsed.data.agent ?? {},
    },
    errors: [],
  };
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
  if (parsed.data.timeout && parseDuration(parsed.data.timeout) === null) {
    errors.push(`${rel}: timeout: expected a duration such as 30m or 2h`);
  }
  return { defaults: parsed.data, errors };
}

// ------------------------------------------------------------------ playbooks

export interface LoadResult {
  /** Absolute paths of the playbook folders that exist. */
  roots: string[];
  exists: boolean;
  entries: PlaybookEntry[];
}

/** True when the workspace has at least one playbook file in any playbook folder. */
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
    const { defaults, errors: defaultsErrors } = await loadDefaults(root, relDir);
    const roleCache = new Map<string, Promise<RoleLoad>>();
    const role = (id: string) => {
      if (!roleCache.has(id)) roleCache.set(id, loadRole(root, relDir, id));
      return roleCache.get(id)!;
    };
    const loads = new Map<string, Promise<Loaded>>();
    const folder: Folder = {
      root,
      relDir,
      defaults,
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
  return { roots, exists: roots.length > 0, entries };
}

/** One playbook folder: its files, defaults, roles, and a cached loader for sub-playbooks. */
interface Folder {
  root: string;
  relDir: string;
  defaults: RawDefaults;
  role: (id: string) => Promise<RoleLoad>;
  ids: Set<string>;
  /** `stack` holds the playbooks being expanded above this one, to refuse self-inclusion. */
  load: (id: string, stack: string[]) => Promise<Loaded>;
}

type Loaded = { entry: PlaybookEntry };

async function loadPlaybook(folder: Folder, name: string, file: string, id: string, stack: string[]): Promise<Loaded> {
  const { root, defaults, role } = folder;
  const entry: PlaybookEntry = { id, file, title: id, errors: [], playbook: null };
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
  const errors: string[] = [];
  const err = (message: string) => errors.push(`${file}: ${message}`);
  if (pb.next !== undefined) err("`next` was removed; include the other playbook as a sub-playbook step (`playbook: <id>`) instead");

  // Playbook inputs.
  const inputs: Record<string, VarDef> = {};
  for (const [name, rawDef] of Object.entries(pb.inputs ?? {})) {
    if (!ID.test(name)) err(`inputs.${name}: invalid name`);
    inputs[name] = toVarDef(rawDef);
    checkVarDef(`${file}: inputs.${name}`, inputs[name]!, errors);
  }

  // Main steps, then after-tasks as steps of their own (no needs), marked with their task id.
  type RawStep = z.infer<typeof RawStepSchema>;
  const rawAll: Array<{ raw: RawStep; task: string | undefined }> = [
    ...pb.steps.map((raw) => ({ raw, task: undefined })),
    ...(pb.after ?? []).map((raw) => ({ raw: { ...raw, needs: [] } as RawStep, task: raw.id })),
  ];
  for (const raw of pb.steps) if (raw.trigger !== undefined) err(`step "${raw.id}": \`trigger\` only applies to an after-task`);
  for (const raw of pb.after ?? []) if (raw.needs !== undefined) err(`after "${raw.id}": \`needs\` does not apply to an after-task (each one starts when the run ends)`);

  // Roles used by agent steps.
  const roles: Record<string, Role> = {};
  for (const roleId of new Set(rawAll.flatMap(({ raw: step }) => (step.role ? [step.role] : [])))) {
    const loaded = await role(roleId);
    if (loaded.role) roles[roleId] = loaded.role;
    else errors.push(...loaded.errors.map((message) => `${file}: role "${roleId}": ${message}`));
  }

  // Steps, first pass. A `playbook:` step is a placeholder until expansion below.
  const seen = new Set<string>();
  const steps: Step[] = [];
  const blocks = new Map<string, Playbook>();
  const defaultTimeout = defaults.timeout ? parseDuration(defaults.timeout) ?? undefined : undefined;
  for (const { raw: rawStep, task } of rawAll) {
    const where = task ? `after "${rawStep.id}"` : `step "${rawStep.id}"`;
    const afterTask = task ? { afterTask: task } : {};
    if (!ID.test(rawStep.id)) err(`${where}: invalid id (lowercase letters, digits, - and _)`);
    if (RESERVED_STEP_IDS.has(rawStep.id)) err(`${where}: "${rawStep.id}" is reserved`);
    if (seen.has(rawStep.id)) err(`${where}: duplicate id`);
    seen.add(rawStep.id);
    const isGate = rawStep.gate !== undefined;
    const isBlock = rawStep.playbook !== undefined;
    if ([rawStep.role, rawStep.gate, rawStep.playbook].filter((value) => value !== undefined).length !== 1) {
      err(`${where}: set exactly one of \`role\`, \`gate\` or \`playbook\``);
    }
    if (isBlock) {
      for (const field of ["prompt", "outputs", "outcomes", "timeout", "agent", "choices", "on"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a playbook step (the sub-playbook defines it)`);
      }
      const subId = rawStep.playbook!;
      let sub: Playbook | null = null;
      if (subId === id || stack.includes(subId)) {
        err(`${where}: playbook "${subId}" includes itself (${[...stack, id, subId].join(" → ")})`);
      } else if (!folder.ids.has(subId)) {
        err(`${where}: playbook "${subId}" not found in ${folder.relDir}/`);
      } else {
        const loaded = await folder.load(subId, [...stack, id]);
        sub = loaded.entry.playbook;
        if (!sub) err(`${where}: playbook "${subId}" is invalid: ${loaded.entry.errors[0] ?? "see that file"}`);
      }
      if (sub) blocks.set(rawStep.id, sub);
      steps.push({
        id: rawStep.id,
        kind: "agent",
        needs: rawStep.needs,
        prompt: "",
        inputs: {},
        outputs: Object.fromEntries(Object.entries(sub?.outputs ?? {}).map(([name, def]) => [name, { type: def.type, ...(def.values ? { values: def.values } : {}) }])),
        outcomes: ["success"],
        retries: 0,
        agent: {},
        on: {},
        choices: [],
        ...afterTask,
      });
      continue;
    }
    if (isGate) {
      for (const field of ["prompt", "inputs", "outputs", "outcomes", "timeout", "agent"] as const) {
        if (rawStep[field] !== undefined) err(`${where}: \`${field}\` does not apply to a gate`);
      }
    }
    if (!isGate && rawStep.choices !== undefined) err(`${where}: \`choices\` only applies to a gate`);
    const choices: GateChoice[] = Object.entries(isGate ? rawStep.choices ?? {} : {}).map(([id, raw]) => {
      if (!ID.test(id)) err(`${where}: choices.${id}: invalid name (lowercase letters, digits, - and _)`);
      const choice: GateChoice = { id, label: raw?.label ?? stepLabel(id.replace(/[_-]+/g, " ")), comment: raw?.comment ?? "none" };
      if (raw?.color) choice.color = raw.color;
      return choice;
    });
    if (isGate && rawStep.choices !== undefined && choices.length === 0) err(`${where}: choices: declare at least one choice`);
    const outcomes = isGate ? (choices.length > 0 ? choices.map((choice) => choice.id) : GATE_OUTCOMES) : rawStep.outcomes ?? AGENT_OUTCOMES;
    const on: Record<string, Transition> = {};
    for (const [outcome, transition] of Object.entries(rawStep.on ?? {})) {
      if (!outcomes.includes(outcome)) err(`${where}: on.${outcome}: not an outcome of this step (${outcomes.join(", ")})`);
      if (typeof transition === "object" && "ask" in transition) {
        if (isGate) err(`${where}: on.${outcome}: \`ask\` only applies to an agent step`);
        on[outcome] = { kind: "ask", ask: transition.ask, target: transition.goto ?? rawStep.id, ...(transition.max_loops !== undefined ? { maxLoops: transition.max_loops } : {}) };
        continue;
      }
      on[outcome] =
        typeof transition === "string"
          ? { kind: transition }
          : transition.max_loops !== undefined
            ? { kind: "goto", target: transition.goto, maxLoops: transition.max_loops }
            : { kind: "goto", target: transition.goto };
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
    let timeoutMs = defaultTimeout;
    if (rawStep.timeout !== undefined) {
      timeoutMs = parseDuration(rawStep.timeout) ?? undefined;
      if (timeoutMs === undefined) err(`${where}: timeout: expected a duration such as 30m or 2h`);
    }
    const stepRole = rawStep.role ? roles[rawStep.role] : undefined;
    const step: Step = {
      id: rawStep.id,
      kind: isGate ? "gate" : "agent",
      needs: rawStep.needs,
      prompt: rawStep.prompt ?? "",
      inputs: {},
      outputs,
      outcomes,
      retries: rawStep.retries,
      agent: isGate ? {} : mergeAgent(defaults.agent, pb.agent, stepRole?.agent, rawStep.agent),
      on,
      choices,
      ...afterTask,
    };
    if (rawStep.role) step.role = rawStep.role;
    if (rawStep.gate !== undefined) step.gate = rawStep.gate;
    if (timeoutMs !== undefined && !isGate) step.timeoutMs = timeoutMs;
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
        if (!ids.has(transition.target)) err(`step "${step.id}": on.${outcome}: goto unknown step "${transition.target}"`);
        else if (transition.target !== step.id && !ancestors.get(step.id)!.has(transition.target)) {
          err(`step "${step.id}": on.${outcome}: goto "${transition.target}" must point to an earlier step this one needs`);
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
      if ("error" in resolved) err(`outputs.${name}: ${resolved.error}`);
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
      if (sub) wireBlock(step, raw, sub, steps, ancestors, inputs, err, after);
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
    blocks: blockInfo,
    after: (pb.after ?? []).map((raw) => ({
      id: raw.id,
      title: raw.title ?? blocks.get(raw.id)?.title ?? stepLabel(raw.id),
      trigger: raw.trigger,
      steps: finalSteps.filter((step) => step.afterTask === raw.id).map((step) => step.id),
    })),
  };
  if (pb.concurrency !== undefined) entry.playbook.concurrency = pb.concurrency;
  return { entry };
}

const PROMPT_REFS = /^(inputs\.[A-Za-z_][\w-]*|run\.id|run\.status|run\.failure|attempt)$/;

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
            err(`${where}: inputs.${name}: step "${source.step}" has no output "${source.output}"`);
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
    if (!PROMPT_REFS.test(ref)) err(`${where}: prompt uses "{{ ${ref} }}"; prompts may only use inputs.<name>, run.id, attempt${after ? ", run.status and run.failure" : ""}${promptHint(ref)}`);
    else if (!after && (ref === "run.status" || ref === "run.failure")) {
      err(`${where}: prompt uses "{{ ${ref} }}", which only after-tasks can use (the run is still running in its own steps)`);
    }
    else if (ref.startsWith("inputs.") && !(ref.slice("inputs.".length) in declared)) {
      err(`${where}: prompt uses "{{ ${ref} }}" but the step declares no such input`);
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
  for (const [blockId, sub] of blocks) {
    const subSteps = mainOf(sub);
    const needed = new Set(subSteps.flatMap((step) => step.needs));
    sinks.set(blockId, subSteps.filter((step) => !needed.has(step.id)).map((step) => `${blockId}.${step.id}`));
    roots.set(blockId, subSteps.filter((step) => step.needs.length === 0).map((step) => `${blockId}.${step.id}`));
    // After-tasks hold no concurrency slot: a sub-playbook used as one has its `concurrency` ignored.
    const limit = !isAfter.has(blockId) && sub.concurrency !== undefined ? { concurrency: sub.concurrency } : {};
    info[blockId] = { title: sub.title, playbook: sub.id, ...limit };
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
        Object.entries(step.on).map(([outcome, transition]) => {
          if ((transition.kind !== "goto" && transition.kind !== "ask") || !blocks.has(transition.target)) return [outcome, transition];
          const first = roots.get(transition.target)!;
          if (first.length !== 1) {
            err(`step "${step.id}": on.${outcome}: goto "${transition.target}" needs a playbook with a single first step (it has ${first.join(", ")})`);
          }
          return [outcome, { ...transition, target: first[0] ?? transition.target }];
        }),
      );
      const inputs = Object.fromEntries(Object.entries(step.inputs).map(([name, wired]) => [name, { ...wired, source: outer(wired.source) }]));
      result.push({ ...step, needs: mapNeeds(step.needs), inputs, on });
      continue;
    }
    for (const innerStep of mainOf(sub)) {
      const on = Object.fromEntries(
        Object.entries(innerStep.on).map(([outcome, transition]) =>
          [outcome, transition.kind === "goto" || transition.kind === "ask" ? { ...transition, target: `${step.id}.${transition.target}` } : transition],
        ),
      );
      const inputs = Object.fromEntries(
        Object.entries(innerStep.inputs).map(([name, wired]) => {
          const source = inner(step.id, sub, wired.source);
          const fromParent = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(singleRef(wired.source) ?? "");
          const label = fromParent ? step.inputs[fromParent[1]!]?.label ?? "(default)" : `${step.id}.${wired.label}`;
          return [name, { ...wired, source, label }];
        }),
      );
      result.push({
        ...innerStep,
        id: `${step.id}.${innerStep.id}`,
        needs: innerStep.needs.length === 0 ? mapNeeds(step.needs) : innerStep.needs.map((need) => `${step.id}.${need}`),
        inputs,
        on,
        ...(step.afterTask ? { afterTask: step.afterTask } : {}),
      });
    }
  }
  for (const [name, output] of Object.entries(outputs)) outputs[name] = { ...output, source: outer(output.source) };
  return { steps: result, blocks: info };
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
        return { error: `step "${source.step}" has no output "${source.output}"` };
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

