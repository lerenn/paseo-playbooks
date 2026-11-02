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
import { parseDuration, singleRef, templateRefs, typeCompatible } from "../shared/vars";
import { checkModes, type Cap } from "./cap";

/** Folders searched for playbooks, relative to the workspace. Each folder is self-contained. */
export const PLAYBOOKS_DIRS = [".paseo/plugins/playbooks", ".paseo/playbooks"] as const;
const ID = /^[a-z][a-z0-9_-]*$/;
const RESERVED_STEP_IDS = new Set(["end", "fail"]);
const AGENT_OUTCOMES = ["success", "failure"];
const GATE_OUTCOMES = DEFAULT_GATE_CHOICES.map((choice) => choice.id);

// ------------------------------------------------------------------ raw YAML

const RawVarDefSchema = z
  .object({
    type: VarTypeSchema.default("string"),
    values: z.array(z.string()).optional(),
    required: z.boolean().optional(),
    default: VarValueSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

const RawOutputSchema = RawVarDefSchema.extend({ value: z.string().optional() }).strict();

const RawTransitionSchema = z.union([
  z.enum(["complete", "end", "fail"]),
  z.object({ goto: z.string(), max_loops: z.number().int().positive().optional() }).strict(),
]);

const RawStepSchema = z
  .object({
    id: z.string(),
    needs: z.array(z.string()).default([]),
    role: z.string().optional(),
    gate: z.string().optional(),
    prompt: z.string().optional(),
    inputs: z.union([z.array(z.string()), z.record(z.string(), z.string().nullable())]).optional(),
    outputs: z.record(z.string(), RawVarDefSchema.nullable()).optional(),
    outcomes: z.array(z.string()).min(1).optional(),
    retries: z.number().int().min(0).default(0),
    timeout: z.string().optional(),
    agent: AgentSettingsSchema.strict().optional(),
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
          .strict()
          .nullable(),
      )
      .optional(),
  })
  .strict();

const RawPlaybookSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    agent: AgentSettingsSchema.strict().optional(),
    inputs: z.record(z.string(), RawVarDefSchema.nullable()).optional(),
    outputs: z.record(z.string(), RawOutputSchema.nullable()).optional(),
    next: z
      .array(
        z
          .object({
            playbook: z.string(),
            on: z.literal("completed").default("completed"),
            inputs: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    concurrency: z.number().int().positive().optional(),
    steps: z.array(RawStepSchema).min(1),
  })
  .strict();

const RawRoleSchema = z
  .object({
    title: z.string().optional(),
    readonly: z.boolean().default(false),
    agent: AgentSettingsSchema.strict().optional(),
  })
  .strict();

const RawDefaultsSchema = z
  .object({
    agent: AgentSettingsSchema.strict().optional(),
    manager: AgentSettingsSchema.strict().optional(),
    timeout: z.string().optional(),
  })
  .strict();
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

type RawNext = Array<{ playbook: string; inputs: Record<string, string> }>;

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
export async function loadPlaybooks(workspaceDir: string, cap: Cap): Promise<LoadResult> {
  const roots: string[] = [];
  const entries: PlaybookEntry[] = [];
  const rawNext = new Map<PlaybookEntry, RawNext>();
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
    for (const name of files) {
      const id = name.replace(/\.ya?ml$/, "");
      const { entry, next } = await loadPlaybook(root, name, `${relDir}/${name}`, id, defaults, role, cap);
      if (defaultsErrors.length > 0) {
        entry.errors.unshift(...defaultsErrors);
        entry.playbook = null;
      }
      entries.push(entry);
      rawNext.set(entry, next);
    }
  }
  for (const entry of entries) {
    const clashes = entries.filter((other) => other !== entry && other.id === entry.id);
    if (clashes.length === 0) continue;
    entry.errors.push(`${entry.file}: playbook id "${entry.id}" is also defined in ${clashes.map((other) => other.file).join(", ")}; rename one`);
    entry.playbook = null;
  }
  linkNext(entries, rawNext);
  return { roots, exists: roots.length > 0, entries };
}

async function loadPlaybook(
  root: string,
  name: string,
  file: string,
  id: string,
  defaults: RawDefaults,
  role: (id: string) => Promise<RoleLoad>,
  cap: Cap,
): Promise<{ entry: PlaybookEntry; next: Array<{ playbook: string; inputs: Record<string, string> }> }> {
  const entry: PlaybookEntry = { id, file, title: id, errors: [], playbook: null };
  const fail = (errors: string[]) => {
    entry.errors.push(...errors);
    return { entry, next: [] };
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

  // Playbook inputs.
  const inputs: Record<string, VarDef> = {};
  for (const [name, rawDef] of Object.entries(pb.inputs ?? {})) {
    if (!ID.test(name)) err(`inputs.${name}: invalid name`);
    inputs[name] = toVarDef(rawDef);
    checkVarDef(`${file}: inputs.${name}`, inputs[name]!, errors);
  }

  // Roles used by agent steps.
  const roles: Record<string, Role> = {};
  for (const roleId of new Set(pb.steps.flatMap((step) => (step.role ? [step.role] : [])))) {
    const loaded = await role(roleId);
    if (loaded.role) roles[roleId] = loaded.role;
    else errors.push(...loaded.errors.map((message) => `${file}: role "${roleId}": ${message}`));
  }

  // Steps, first pass.
  const seen = new Set<string>();
  const steps: Step[] = [];
  const defaultTimeout = defaults.timeout ? parseDuration(defaults.timeout) ?? undefined : undefined;
  for (const rawStep of pb.steps) {
    const where = `step "${rawStep.id}"`;
    if (!ID.test(rawStep.id)) err(`${where}: invalid id (lowercase letters, digits, - and _)`);
    if (RESERVED_STEP_IDS.has(rawStep.id)) err(`${where}: "${rawStep.id}" is reserved`);
    if (seen.has(rawStep.id)) err(`${where}: duplicate id`);
    seen.add(rawStep.id);
    const isGate = rawStep.gate !== undefined;
    if (isGate === (rawStep.role !== undefined)) err(`${where}: set exactly one of \`role\` or \`gate\``);
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
      on[outcome] =
        typeof transition === "string"
          ? { kind: transition }
          : transition.max_loops !== undefined
            ? { kind: "goto", target: transition.goto, maxLoops: transition.max_loops }
            : { kind: "goto", target: transition.goto };
    }
    if (!isGate) {
      const extra = outcomes.slice(1).filter((outcome) => outcome !== "failure" && !on[outcome]);
      for (const outcome of extra) err(`${where}: outcome "${outcome}" needs an \`on\` entry`);
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
    };
    if (rawStep.role) step.role = rawStep.role;
    if (rawStep.gate !== undefined) step.gate = rawStep.gate;
    if (timeoutMs !== undefined && !isGate) step.timeoutMs = timeoutMs;
    steps.push(step);
  }

  // Graph checks.
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const need of step.needs) if (!ids.has(need)) err(`step "${step.id}": needs unknown step "${need}"`);
    if (step.needs.includes(step.id)) err(`step "${step.id}": needs itself`);
  }
  const cycle = findCycle(steps);
  if (cycle) err(`needs form a cycle: ${cycle.join(" → ")}`);
  if (errors.length === 0) {
    const ancestors = new Map(steps.map((step) => [step.id, ancestorsOf(steps, step.id)]));
    for (const step of steps) {
      for (const [outcome, transition] of Object.entries(step.on)) {
        if (transition.kind !== "goto") continue;
        if (!ids.has(transition.target)) err(`step "${step.id}": on.${outcome}: goto unknown step "${transition.target}"`);
        else if (transition.target !== step.id && !ancestors.get(step.id)!.has(transition.target)) {
          err(`step "${step.id}": on.${outcome}: goto "${transition.target}" must point to an earlier step this one needs`);
        }
      }
    }
    // Concurrency rule: two steps that may run together must not both edit files.
    const agents = steps.filter((step) => step.kind === "agent" && step.role && roles[step.role]);
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i]!;
        const b = agents[j]!;
        if (ancestors.get(a.id)!.has(b.id) || ancestors.get(b.id)!.has(a.id)) continue;
        if (!roles[a.role!]!.readonly && !roles[b.role!]!.readonly) {
          err(`steps "${a.id}" and "${b.id}" can run at the same time and both may edit files; make one role readonly or order them with needs`);
        }
      }
    }
    // Inputs wiring and prompt references.
    for (const step of steps) wireStep(step, pb.steps.find((raw) => raw.id === step.id)!, steps, ancestors.get(step.id)!, inputs, err);
  }

  // Playbook outputs.
  const outputs: Playbook["outputs"] = {};
  if (errors.length === 0) {
    for (const [name, rawOutput] of Object.entries(pb.outputs ?? {})) {
      const def = toVarDef(rawOutput);
      checkVarDef(`${file}: outputs.${name}`, def, errors);
      const resolved = resolveOutputSource(name, def.type, rawOutput?.value, steps, inputs);
      if ("error" in resolved) err(`outputs.${name}: ${resolved.error}`);
      else outputs[name] = { ...def, ...resolved };
    }
  }

  // Agent modes against the daemon cap.
  const manager = mergeAgent(defaults.agent?.provider ? { provider: defaults.agent.provider, model: defaults.agent.model } : undefined, defaults.manager);
  for (const message of checkModes(cap, manager, steps)) err(message);

  if (errors.length > 0) return fail(errors);
  entry.playbook = {
    id,
    title: entry.title,
    description: pb.description ?? "",
    file,
    inputs,
    outputs,
    next: [],
    steps,
    roles,
    manager,
  };
  if (pb.concurrency !== undefined) entry.playbook.concurrency = pb.concurrency;
  return {
    entry,
    next: (pb.next ?? []).map((next) => ({ playbook: next.playbook, inputs: next.inputs ?? {} })),
  };
}

const PROMPT_REFS = /^(inputs\.[A-Za-z_][\w-]*|run\.id|attempt)$/;

function parseSourceRef(ref: string): { kind: "playbook"; name: string } | { kind: "step"; step: string; output: string } | null {
  const playbook = /^playbook\.inputs\.([A-Za-z_][\w-]*)$/.exec(ref);
  if (playbook) return { kind: "playbook", name: playbook[1]! };
  const step = /^steps\.([a-z][a-z0-9_-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
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
): void {
  const where = `step "${step.id}"`;
  const declared: Record<string, string | null> = Array.isArray(raw.inputs)
    ? Object.fromEntries(raw.inputs.map((name) => [name, null]))
    : raw.inputs ?? {};
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
        if (!source) {
          err(`${where}: inputs.${name}: "{{ ${ref} }}" must be playbook.inputs.<name> or steps.<id>.outputs.<name>`);
          ok = false;
        } else if (source.kind === "playbook" && !playbookInputs[source.name]) {
          err(`${where}: inputs.${name}: playbook input "${source.name}" is not declared`);
          ok = false;
        } else if (source.kind === "step") {
          if (!ancestors.has(source.step)) {
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
        type = source.kind === "playbook" ? playbookInputs[source.name]!.type : byId.get(source.step)!.outputs[source.output]!.type;
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
    } else if (playbookInputs[name]) {
      step.inputs[name] = wiring(`{{ playbook.inputs.${name} }}`, true, `playbook.${name}`, playbookInputs[name]!.type);
    } else {
      err(`${where}: input "${name}" has no source: no earlier step outputs it and the playbook has no such input`);
    }
  }
  for (const ref of templateRefs(step.prompt)) {
    if (!PROMPT_REFS.test(ref)) err(`${where}: prompt uses "{{ ${ref} }}"; prompts may only use inputs.<name>, run.id and attempt`);
    else if (ref.startsWith("inputs.") && !(ref.slice("inputs.".length) in declared)) {
      err(`${where}: prompt uses "{{ ${ref} }}" but the step declares no such input`);
    }
  }
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
      if (!source) return { error: `"{{ ${ref} }}" must be playbook.inputs.<name> or steps.<id>.outputs.<name>` };
      if (source.kind === "playbook" && !inputs[source.name]) return { error: `playbook input "${source.name}" is not declared` };
      if (source.kind === "step" && !byId.get(source.step)?.outputs[source.output]) {
        return { error: `step "${source.step}" has no output "${source.output}"` };
      }
    }
    const single = singleRef(explicit);
    if (single) {
      const source = parseSourceRef(single)!;
      const fromType = source.kind === "playbook" ? inputs[source.name]!.type : byId.get(source.step)!.outputs[source.output]!.type;
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

/** Validates `next` entries once every playbook in the folder is loaded. */
function linkNext(entries: PlaybookEntry[], rawNext: Map<PlaybookEntry, RawNext>): void {
  const byId = new Map(entries.filter((entry) => entry.playbook).map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (!entry.playbook) continue;
    for (const next of rawNext.get(entry) ?? []) {
      const target = byId.get(next.playbook)?.playbook;
      if (!target) {
        entry.errors.push(`${entry.file}: next: playbook "${next.playbook}" not found or invalid`);
        continue;
      }
      for (const [name, def] of Object.entries(target.inputs)) {
        if (next.inputs[name] !== undefined) continue;
        if (entry.playbook.outputs[name] || entry.playbook.inputs[name]) continue;
        if (def.required && def.default === undefined) {
          entry.errors.push(`${entry.file}: next "${next.playbook}": required input "${name}" has no matching output; map it in next.inputs`);
        }
      }
      for (const name of Object.keys(next.inputs)) {
        if (!target.inputs[name]) entry.errors.push(`${entry.file}: next "${next.playbook}": unknown input "${name}"`);
      }
      entry.playbook.next.push({ playbook: next.playbook, on: "completed", inputs: next.inputs });
    }
    if (entry.errors.length > 0) entry.playbook = null;
  }
}
