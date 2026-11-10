/**
 * Pure run-state transitions. Nothing here talks to Paseo or the filesystem: the runtime
 * applies the returned effects (cancel agents, wake the manager).
 */
import { descendantsOf } from "../shared/graph";
import { blockEntrySteps, blockStepIds, holdsBlock, innermostBlock } from "../shared/slots";
import { askChoices, askHumanText, askTransitionOf, choicesOfGate, outcomeTransition } from "../shared/gates";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type { AfterTask, AskChoice, Attempt, Gate, GateDecider, Job, Playbook, Run, RunStep, RunWorktree, Step, Transition, VarValue } from "../shared/types";
import { isActive, isAgentlessAttempt, isPaused, isPipeline, isStepDone, isStepLive, isTerminal, restartBlocker, runningAfterTasks } from "../shared/types";
import { coerceValue, formatValue, parseDuration, renderTemplate, replaceRefs, resolveValue, templateRefs } from "../shared/vars";

export class EngineError extends Error {}

export interface Effects {
  /** Step agents whose running turn must be interrupted. */
  cancelAgents: string[];
  /** Agents of completed steps, no longer needed: archived to free their sessions. */
  archiveAgents: string[];
  /** Human-readable lines for the manager. */
  notes: string[];
}

function effects(): Effects {
  return { cancelAgents: [], archiveAgents: [], notes: [] };
}

export function stepDef(run: Run, stepId: string): Step {
  const step = run.playbook.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new EngineError(`unknown step "${stepId}" in playbook "${run.playbook.id}"`);
  return step;
}

function runStep(run: Run, stepId: string): RunStep {
  stepDef(run, stepId);
  return run.steps[stepId]!;
}

function log(run: Run, now: string, type: string, stepId: string | null, detail: string): void {
  run.seq += 1;
  run.history.push({ seq: run.seq, at: now, type, stepId, detail });
  run.updatedAt = now;
}

/** Adds an entry to the run's history. */
export function noteEvent(run: Run, type: string, stepId: string | null, detail: string, now: string): void {
  log(run, now, type, stepId, detail);
}

/** A main step moves while the run is not finished; an after-step while its task runs. */
function assertLive(run: Run, stepId: string): void {
  if (isStepLive(run, stepId)) return;
  const task = stepDef(run, stepId).afterTask;
  if (task) {
    const status = run.after[task]?.status ?? "pending";
    throw new EngineError(`after-task "${task}" is ${status === "pending" ? "not started" : status}`);
  }
  throw new EngineError(`run ${run.id} is ${run.status}`);
}

function afterTaskDef(run: Run, taskId: string): AfterTask {
  const task = run.playbook.after.find((candidate) => candidate.id === taskId);
  if (!task) throw new EngineError(`no after-task "${taskId}" in playbook "${run.playbook.id}"`);
  return task;
}

export interface NewRunInput {
  id: string;
  playbook: Playbook;
  workspaceId: string;
  workspaceDir: string;
  projectId: string;
  branch: string | null;
  managerAgentId: string;
  name?: string | null;
  /** The plugin created the workspace for this run. */
  workspaceCreated?: boolean;
  /** The run's private git worktree (`isolation: worktree`), already created. */
  worktree?: RunWorktree;
  inputs: Record<string, unknown>;
  now: string;
}

/** Validates inputs against the playbook (applying defaults) and returns them, or errors. */
export function resolveRunInputs(
  playbook: Playbook,
  given: Record<string, unknown>,
): { ok: true; inputs: Record<string, VarValue> } | { ok: false; errors: string[] } {
  const inputs: Record<string, VarValue> = {};
  const errors: string[] = [];
  for (const name of Object.keys(given)) {
    if (!playbook.inputs[name]) errors.push(`unknown input "${name}"`);
  }
  for (const [name, def] of Object.entries(playbook.inputs)) {
    const raw = given[name] ?? def.default;
    if (raw === undefined || raw === "") {
      if (def.required) errors.push(`input "${name}" is required`);
      continue;
    }
    const coerced = coerceValue(def, raw);
    if (coerced.ok) inputs[name] = coerced.value;
    else errors.push(`input "${name}": ${coerced.error}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, inputs };
}

/** Validates one job's inputs against a singleton playbook (every input of a singleton is each job's). */
export function resolveJobInputs(playbook: Playbook, given: Record<string, unknown>) {
  return resolveRunInputs(playbook, given);
}

export function newRun(input: NewRunInput): Run {
  const resolved = resolveRunInputs(input.playbook, input.inputs);
  if (!resolved.ok) throw new EngineError(resolved.errors.join("; "));
  return createRun(input, resolved.inputs, "run");
}

/**
 * A singleton's pipeline: one long-lived run that keeps the stations' waiting lists and the
 * jobs. It has no manager and starts no step: each train is a run of its own (newTrainRun).
 */
export function newPipelineRun(input: Omit<NewRunInput, "managerAgentId" | "inputs">): Run {
  return createRun({ ...input, managerAgentId: "", inputs: {} }, {}, "pipeline");
}

/**
 * The playbook a station's trains run: the station's steps alone (a sub-playbook's expanded
 * steps, or one step), with their needs kept inside the station.
 */
export function stationPlaybook(pipeline: Playbook, stationId: string): Playbook {
  const station = pipeline.singleton?.stations.find((candidate) => candidate.id === stationId);
  if (!station) throw new EngineError(`no station "${stationId}" in "${pipeline.id}"`);
  const own = new Set(station.steps);
  const blocks = Object.fromEntries(Object.entries(pipeline.blocks).filter(([prefix]) => prefix === station.id || prefix.startsWith(`${station.id}.`)));
  // A train's manager gets the repository's, the pipeline's and its station's sub-playbooks' instructions.
  const used = new Set([pipeline.id, ...Object.values(blocks).map((block) => block.playbook)]);
  return {
    ...pipeline,
    id: `${pipeline.id}.${station.id}`,
    title: `${pipeline.title} · ${station.title}`,
    inputs: {},
    outputs: {},
    outcomes: ["success"],
    steps: pipeline.steps.filter((step) => own.has(step.id)).map((step) => ({ ...step, needs: step.needs.filter((need) => own.has(need)) })),
    // The station's own block is the whole train: an `end` in it ends the train.
    blocks: Object.fromEntries(Object.entries(blocks).filter(([prefix]) => prefix.startsWith(`${station.id}.`))),
    managerInstructions: (pipeline.managerInstructions ?? []).filter((entry) => entry.playbook === null || used.has(entry.playbook)),
    after: [],
    singleton: undefined,
  };
}

function createRun(input: NewRunInput, inputs: Record<string, VarValue>, kind: "run" | "pipeline"): Run {
  const run: Run = {
    version: 1,
    id: input.id,
    playbook: input.playbook,
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
    projectId: input.projectId,
    branch: input.branch,
    managerAgentId: input.managerAgentId,
    name: input.name ?? null,
    inputs,
    outputs: null,
    status: "running",
    failure: null,
    createdAt: input.now,
    updatedAt: input.now,
    workspaceCreated: input.workspaceCreated ?? false,
    workspaceArchive: null,
    worktree: input.worktree ?? null,
    archivedAt: null,
    seenAt: null,
    pausedAt: null,
    steps: Object.fromEntries(
      input.playbook.steps.map((step) => [
        step.id,
        { status: "pending", attempts: [], outputs: {}, summary: null, feedback: null, loop: 0, completedSeq: null, queuedAt: null },
      ]),
    ),
    loops: {},
    loopAllowance: {},
    loopTotals: {},
    gates: [],
    after: Object.fromEntries(
      input.playbook.after.map((task) => [task.id, { status: "pending", startedAt: null, endedAt: null, detail: null }]),
    ),
    inbox: [],
    jobs: [],
    train: null,
    history: [],
    seq: 0,
  };
  if (kind === "pipeline") {
    log(run, input.now, "pipeline_started", null, `playbook ${input.playbook.id}`);
    return run;
  }
  // A templated timeout that only depends on the run's inputs is checked now, not at its step.
  for (const step of input.playbook.steps) {
    if (step.timeout === undefined) continue;
    const used = templateRefs(step.timeout).map((ref) => step.inputs[ref.slice("inputs.".length)]?.source ?? "");
    if (used.some((source) => templateRefs(source).some((ref) => !ref.startsWith("playbook.inputs.")))) continue;
    const resolved = resolveTimeout(step, stepInputs(run, step));
    if (!resolved.ok) throw new EngineError(resolved.error);
  }
  log(run, input.now, "run_started", null, `playbook ${input.playbook.id}`);
  refreshReady(run, input.now);
  return run;
}

/**
 * Pending steps whose needs are all completed become ready, except the first steps of a
 * block with `concurrency` while it is not held: those are queued until the runtime admits
 * them (see planAdmissions). Returns the newly ready and the newly queued ids.
 */
export function refreshReady(run: Run, now: string): { ready: string[]; queued: string[] } {
  const ready: string[] = [];
  const queued: string[] = [];
  if (run.status === "boarding" || isPipeline(run)) return { ready, queued };
  const limited = Object.entries(run.playbook.blocks).filter(([, block]) => block.concurrency !== undefined);
  // A skipped step (its `when` did not match) counts as done, so the steps after it may move too.
  let skipped = true;
  while (skipped) {
    skipped = false;
    for (const step of run.playbook.steps) {
      const state = run.steps[step.id]!;
      if (state.status !== "pending" || !step.when || !isStepLive(run, step.id)) continue;
      if (!step.needs.every((need) => isStepDone(run.steps[need]?.status ?? "pending"))) continue;
      const missed = unmetWhen(run, step);
      if (missed === null) continue;
      state.status = "skipped";
      state.completedSeq = null;
      log(run, now, "step_skipped", step.id, missed);
      skipped = true;
    }
  }
  for (const step of run.playbook.steps) {
    const state = run.steps[step.id]!;
    if (state.status !== "pending" || !isStepLive(run, step.id)) continue;
    if (!step.needs.every((need) => { const status = run.steps[need]?.status; return status !== undefined && isStepDone(status); })) continue;
    const gating = limited.some(([prefix]) => blockEntrySteps(run.playbook, prefix).includes(step.id) && !holdsBlock(run, prefix));
    if (gating) {
      state.status = "queued";
      state.queuedAt = now;
      queued.push(step.id);
      log(run, now, "step_queued", step.id, "waiting for a free concurrency slot");
    } else {
      state.status = "ready";
      ready.push(step.id);
    }
  }
  return { ready, queued };
}

/** Why a step's `when` does not hold now (e.g. `when env is dev, not prd`), or null when it does. */
export function unmetWhen(run: Run, step: Step): string | null {
  const context = templateContext(run);
  for (const condition of step.when ?? []) {
    if (condition.loop) {
      const loop = run.steps[step.id]?.loop ?? 0;
      if (!condition.loop.some((test) => loopTest(test, loop))) return `when: loop is ${loop}, not ${condition.loop.map((test) => `${test.op}${test.value}`).join(" or ")}`;
      continue;
    }
    const value = formatValue(resolveValue(condition.source, context));
    if (!condition.values.includes(value)) return `when: ${condition.input} is ${value}, not ${condition.values.join(" or ")}`;
  }
  return null;
}

function loopTest(test: { op: "==" | ">=" | "<=" | ">" | "<"; value: number }, loop: number): boolean {
  switch (test.op) {
    case "==": return loop === test.value;
    case ">=": return loop >= test.value;
    case "<=": return loop <= test.value;
    case ">": return loop > test.value;
    case "<": return loop < test.value;
  }
}

/** Steps waiting for a free `concurrency` slot of their block. */
export function queuedSteps(run: Run): string[] {
  return run.playbook.steps.filter((step) => run.steps[step.id]!.status === "queued").map((step) => step.id);
}

/** Lets a queued block start: its queued steps become ready. Returns them. */
export function admitBlock(run: Run, prefix: string, now: string): string[] {
  if (isTerminal(run.status)) return [];
  const admitted = blockStepIds(run.playbook, prefix).filter((id) => run.steps[id]!.status === "queued");
  for (const id of admitted) {
    run.steps[id]!.status = "ready";
    run.steps[id]!.queuedAt = null;
    log(run, now, "step_admitted", id, "got a concurrency slot");
  }
  return admitted;
}

function queueNote(run: Run, queued: string[]): string {
  const playbooks = [...new Set(Object.entries(run.playbook.blocks).filter(([prefix]) => queued.some((id) => id.startsWith(`${prefix}.`))).map(([, block]) => block.playbook))];
  return `Queued: ${queued.join(", ")}, waiting for a free "${playbooks.join('", "')}" slot held by other runs. You are woken when they are ready; do not start them before.`;
}

/**
 * Ready steps the manager starts (a finished run's leftover ready steps are not listed).
 * Script steps are left out: the plugin runs them itself (see readyScripts).
 */
export function readySteps(run: Run): string[] {
  return run.playbook.steps
    .filter((step) => step.kind !== "script" && step.kind !== "handoff" && run.steps[step.id]!.status === "ready" && isStepLive(run, step.id))
    .map((step) => step.id);
}

/** Ready hand-off steps, which the plugin starts on its own. */
export function readyHandoffs(run: Run): string[] {
  return run.playbook.steps
    .filter((step) => step.kind === "handoff" && run.steps[step.id]!.status === "ready" && isStepLive(run, step.id))
    .map((step) => step.id);
}

/** Ready script steps, which the plugin starts on its own. */
export function readyScripts(run: Run): string[] {
  return run.playbook.steps
    .filter((step) => step.kind === "script" && run.steps[step.id]!.status === "ready" && isStepLive(run, step.id))
    .map((step) => step.id);
}

function updateStatus(run: Run): void {
  if (isTerminal(run.status)) return;
  run.status = run.gates.some((gate) => gate.status === "pending") ? "waiting_gate" : "running";
}

function baseContext(run: Run): Record<string, unknown> & { run: Record<string, unknown> } {
  return {
    playbook: { inputs: run.inputs },
    steps: Object.fromEntries(
      Object.entries(run.steps).map(([id, state]) => [id, { outputs: state.outputs, summary: state.summary }]),
    ),
    run: { id: run.id, status: run.status, failure: run.failure },
  };
}

/**
 * What input sources render against. `run.outputs` are the run's outputs once it completed,
 * or what they would be now (possibly partial): after-tasks of a failed run read them too.
 */
export function templateContext(run: Run): Record<string, unknown> {
  const context = baseContext(run);
  context.run.outputs = run.outputs ?? outputsFrom(run, context);
  return context;
}

/** Values and sources a step would receive now. */
export function stepInputs(run: Run, step: Step): Record<string, { value: VarValue | undefined; source: string }> {
  const context = templateContext(run);
  return Object.fromEntries(
    Object.entries(step.inputs).map(([name, wiring]) => [
      name,
      { value: resolveValue(wiring.source, context), source: `${wiring.label}${wiring.auto ? " (auto)" : ""}` },
    ]),
  );
}

/**
 * A step's timeout for an attempt starting now. A templated `timeout` renders with the step's
 * input values; an empty value falls back to the step's `timeoutMs` (the defaults' timeout).
 */
export function resolveTimeout(
  step: Step,
  values: Record<string, { value: VarValue | undefined }>,
): { ok: true; timeoutMs: number | undefined } | { ok: false; error: string } {
  if (step.timeout === undefined) return { ok: true, timeoutMs: step.timeoutMs };
  let empty = false;
  const text = replaceRefs(step.timeout, (ref) => {
    const value = values[ref.slice("inputs.".length)]?.value;
    if (value === undefined || value === "") empty = true;
    return value === undefined ? "" : String(value);
  });
  if (empty) return { ok: true, timeoutMs: step.timeoutMs };
  const timeoutMs = parseDuration(text);
  if (timeoutMs === null) return { ok: false, error: `step "${step.id}": timeout "${step.timeout}" gave "${text}", expected a duration such as 30m or 2h` };
  return { ok: true, timeoutMs };
}

export interface StartedStep {
  attempt: Attempt;
  /** First prompt for the step agent: rendered step prompt, inputs, feedback and brief. */
  prompt: string;
}

/** Records a new attempt for a ready agent step. */
export function startAttempt(
  run: Run,
  stepId: string,
  input: { agentId: string; brief: string; now: string; readonlySnapshot: string | null },
): StartedStep {
  assertLive(run, stepId);
  const step = stepDef(run, stepId);
  const state = runStep(run, stepId);
  if (step.kind === "gate") throw new EngineError(`step "${stepId}" is a gate; call request_gate`);
  if (isPaused(run)) {
    throw new EngineError(`run ${run.id} is paused by a human: no step starts until it is resumed. End your turn; you are woken on resume.`);
  }
  if (state.status !== "ready") {
    throw new EngineError(`step "${stepId}" is ${state.status}, not ready (ready now: ${readySteps(run).join(", ") || "none"})`);
  }
  const values = stepInputs(run, step);
  const timeout = resolveTimeout(step, values);
  if (!timeout.ok) throw new EngineError(timeout.error);
  const n = state.attempts.length + 1;
  const attempt: Attempt = {
    n,
    agentId: input.agentId,
    startedAt: input.now,
    endedAt: null,
    brief: input.brief,
    inputs: Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, { value: formatValue(entry.value), source: entry.source }])),
    report: null,
    lastMessage: null,
    outcome: null,
    turnEnd: null,
    readonlySnapshot: input.readonlySnapshot,
    reminded: false,
    silenceReminded: false,
    reopenedAt: null,
    timeoutMs: timeout.timeoutMs ?? null,
    checks: 0,
    nextCheckAt: null,
    job: null,
    noRetry: false,
  };
  const context = {
    inputs: Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, entry.value])),
    run: { id: run.id, status: run.status, failure: run.failure, jobs: jobsText(run) },
    worktree: workDir(run),
    attempt: n,
    loop: state.loop,
  };
  const sections: string[] = [];
  const rendered = renderTemplate(step.prompt, context).trim();
  if (rendered) sections.push(rendered);
  if (Object.keys(values).length > 0 && !step.prompt.includes("{{")) {
    sections.push(["Inputs:", ...Object.entries(values).map(([name, entry]) => `- ${name}: ${formatValue(entry.value)}`)].join("\n"));
  }
  if (state.feedback) sections.push(`Feedback to address (from the previous round):\n${state.feedback}`);
  if (input.brief.trim()) sections.push(`Brief from the Playbook Manager:\n${input.brief.trim()}`);
  state.attempts.push(attempt);
  state.status = "running";
  state.feedback = null;
  log(run, input.now, "step_started", stepId, `attempt ${n}, agent ${input.agentId}`);
  return { attempt, prompt: sections.join("\n\n") };
}

export function currentAttempt(run: Run, stepId: string): Attempt | null {
  return runStep(run, stepId).attempts.at(-1) ?? null;
}

/** Finds the run step whose latest attempt belongs to this agent. */
export function findAttemptByAgent(run: Run, agentId: string): { stepId: string; attempt: Attempt } | null {
  for (const [stepId, state] of Object.entries(run.steps)) {
    const attempt = state.attempts.at(-1);
    if (attempt?.agentId === agentId) return { stepId, attempt };
  }
  return null;
}

/** Checks a report's outputs against the step's declared types. All declared outputs are required. */
export function validateOutputs(
  step: Step,
  outputs: Record<string, unknown>,
): { ok: true; outputs: Record<string, VarValue> } | { ok: false; errors: string[] } {
  const result: Record<string, VarValue> = {};
  const errors: string[] = [];
  for (const [name, def] of Object.entries(step.outputs)) {
    const raw = outputs[name];
    if (raw === undefined || raw === null || raw === "") {
      errors.push(`missing output "${name}" (${def.type})`);
      continue;
    }
    const coerced = coerceValue(def, raw);
    if (coerced.ok) result[name] = coerced.value;
    else errors.push(`output "${name}": ${coerced.error}`);
  }
  for (const name of Object.keys(outputs)) {
    if (!step.outputs[name]) errors.push(`unknown output "${name}" (declared: ${Object.keys(step.outputs).join(", ") || "none"}). Loop feedback is not an output: put it in complete_step's "summary".`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, outputs: result };
}

/**
 * A hand-off's outputs are the singleton's, all set only when its job leaves with the first
 * outcome; a job ended early (no_deploy, stopped, ejected) brings what it has.
 */
function outputsRequired(step: Step, outcome: string): boolean {
  return !(step.kind === "handoff" && outcome !== step.outcomes[0]);
}

/** The declared outputs a report gives with the right type; missing or wrong ones are left out. */
function partialOutputs(step: Step, outputs: Record<string, unknown>): Record<string, VarValue> {
  const result: Record<string, VarValue> = {};
  for (const [name, def] of Object.entries(step.outputs)) {
    const raw = outputs[name];
    if (raw === undefined || raw === null || raw === "") continue;
    const coerced = coerceValue(def, raw);
    if (coerced.ok) result[name] = coerced.value;
  }
  return result;
}

/** Stores a step agent's report on its running attempt. */
export function recordReport(
  run: Run,
  agentId: string,
  report: { outcome: string; summary: string; outputs: Record<string, unknown> },
  now: string,
): { stepId: string } {
  const found = findAttemptByAgent(run, agentId);
  if (!found) throw new EngineError("this agent is not the current attempt of any step");
  const { stepId, attempt } = found;
  assertLive(run, stepId);
  const step = stepDef(run, stepId);
  if (attempt.endedAt !== null && attempt.report !== null) throw new EngineError("this attempt already reported");
  if (!step.outcomes.includes(report.outcome)) {
    throw new EngineError(`outcome "${report.outcome}" is not allowed; use one of: ${step.outcomes.join(", ")}`);
  }
  let outputs: Record<string, VarValue> = {};
  const kind = defaultTransition(step, report.outcome).kind;
  // A failure, or a question for a human (`ask`), is not a result: no outputs expected.
  if (report.outcome !== "failure" && kind !== "ask" && !outputsRequired(step, report.outcome)) {
    outputs = partialOutputs(step, report.outputs);
  } else if (report.outcome !== "failure" && kind !== "ask") {
    const checked = validateOutputs(step, report.outputs);
    if (!checked.ok) throw new EngineError(`report refused: ${checked.errors.join("; ")}. Fix these and call report_step_result again.`);
    outputs = checked.outputs;
  } else if (kind === "ask") {
    // Kept as given, for an ask choice that ends the step with `outputs` reading `report.outputs`.
    outputs = partialOutputs(step, report.outputs);
  }
  attempt.report = { outcome: report.outcome, summary: report.summary, outputs };
  log(run, now, "step_reported", stepId, `${report.outcome}: ${report.summary}`);
  return { stepId };
}

/** The step agent's turn ended. Moves a running step to reported. */
export function endTurn(
  run: Run,
  agentId: string,
  input: { turnEnd: NonNullable<Attempt["turnEnd"]>; lastMessage: string | null; now: string },
): { stepId: string; attempt: Attempt } | null {
  const found = findAttemptByAgent(run, agentId);
  if (!found) return null;
  const state = run.steps[found.stepId]!;
  if (state.status !== "running") return null;
  found.attempt.endedAt = input.now;
  found.attempt.turnEnd = input.turnEnd;
  if (!found.attempt.report) found.attempt.lastMessage = input.lastMessage;
  state.status = "reported";
  log(run, input.now, "step_turn_ended", found.stepId, input.turnEnd);
  return found;
}

/**
 * nudge_step on a reported step: the agent works again and its next turn end reports again.
 * A timed-out attempt drops the plugin's timeout failure, so the agent's next report_step_result
 * replaces it; its timeout counts again from now.
 */
export function reopenAttempt(run: Run, stepId: string, now: string): Attempt {
  assertLive(run, stepId);
  const state = runStep(run, stepId);
  const attempt = state.attempts.at(-1);
  if (state.status !== "reported" || !attempt) throw new EngineError(`step "${stepId}" is ${state.status}; only a reported step can be reopened`);
  const timedOut = attempt.turnEnd === "timeout";
  if (timedOut) {
    attempt.report = null;
    attempt.lastMessage = null;
  }
  state.status = "running";
  attempt.endedAt = null;
  attempt.turnEnd = null;
  attempt.reopenedAt = now;
  attempt.silenceReminded = false;
  log(run, now, "step_reopened", stepId, timedOut ? `attempt ${attempt.n}, after its timeout` : `attempt ${attempt.n}`);
  return attempt;
}

export function defaultTransition(step: Step, outcome: string) {
  if (step.on[outcome]) return step.on[outcome]!;
  if (step.kind === "gate") return outcomeTransition(step, outcome);
  if (outcome === "failure") return { kind: "retry" } as const;
  if (outcome === step.outcomes[0] || outcome === "success") return { kind: "complete" } as const;
  return { kind: "fail" } as const;
}

function finish(run: Run, status: "completed" | "failed" | "canceled", detail: string, now: string, fx: Effects): void {
  for (const [stepId, state] of Object.entries(run.steps)) {
    if (state.status !== "running") continue;
    const attempt = state.attempts.at(-1);
    if (attempt) {
      fx.cancelAgents.push(attempt.agentId);
      attempt.turnEnd = "canceled";
      attempt.endedAt = now;
    }
    state.status = "failed";
    log(run, now, "step_canceled", stepId, detail);
  }
  archiveEnded(run, run.playbook.steps.map((step) => step.id), fx);
  for (const gate of run.gates) {
    if (gate.status === "pending") {
      gate.status = "rejected";
      gate.comment = `run ${status}`;
      gate.decidedAt = now;
    }
  }
  run.status = status;
  if (status !== "completed") run.failure = detail;
  log(run, now, `run_${status}`, null, detail);
  fx.notes.push(`Run ${run.id} ${status}${status === "completed" ? "" : `: ${detail}`}.`);
}

function outputsFrom(run: Run, context: Record<string, unknown>): Record<string, VarValue> {
  const outputs: Record<string, VarValue> = {};
  for (const [name, def] of Object.entries(run.playbook.outputs)) {
    if (def.source === "") continue;
    const value = resolveValue(def.source, context);
    if (value === undefined) continue;
    const coerced = coerceValue(def, value);
    if (coerced.ok) outputs[name] = coerced.value;
  }
  return outputs;
}

function completeRun(run: Run, now: string, fx: Effects): void {
  run.outputs = outputsFrom(run, baseContext(run));
  finish(run, "completed", "", now, fx);
  const shown = Object.entries(run.outputs).map(([name, value]) => `${name}=${value}`).join(", ");
  if (shown) fx.notes.push(`Outputs: ${shown}.`);
  startAutoTasks(run, now, fx);
}

/** The main graph failed: the run is failed, then its auto after-tasks start. */
function failMain(run: Run, detail: string, now: string, fx: Effects): void {
  finish(run, "failed", detail, now, fx);
  startAutoTasks(run, now, fx);
}

/** Where `end` / `fail` lead: the run for a main step, only its task for an after-step. */
function endFlow(run: Run, step: Step, status: "completed" | "failed", detail: string, now: string, fx: Effects): void {
  if (step.afterTask) finishTask(run, step.afterTask, status, detail, now, fx);
  else if (status === "completed") completeRun(run, now, fx);
  else failMain(run, detail, now, fx);
}

// ---------------------------------------------------------------- after-tasks

function launchTask(run: Run, taskId: string, now: string): string[] {
  const task = afterTaskDef(run, taskId);
  run.after[taskId] = { status: "running", startedAt: now, endedAt: null, detail: null };
  log(run, now, "after_started", null, taskId);
  for (const stepId of task.steps) {
    const state = run.steps[stepId]!;
    state.status = "pending";
    state.outputs = {};
    state.completedSeq = null;
  }
  const { ready } = refreshReady(run, now);
  return ready.filter((id) => task.steps.includes(id));
}

function afterNote(run: Run, started: string[], ready: string[]): string {
  return `After-task${started.length === 1 ? "" : "s"} started: ${started.join(", ")}. ${started.length === 1 ? "It does" : "They do"} not change the run's result (${run.status}). Ready: ${ready.join(", ") || "none"}; start ${ready.length === 1 ? "it" : "them"} like any step.`;
}

/** Starts the `auto` after-tasks of a run that just completed or failed. */
function startAutoTasks(run: Run, now: string, fx: Effects): void {
  const auto = run.playbook.after.filter((task) => task.trigger === "auto" && run.after[task.id]?.status === "pending");
  if (auto.length === 0) return;
  const ready = auto.flatMap((task) => launchTask(run, task.id, now));
  fx.notes.push(afterNote(run, auto.map((task) => task.id), ready));
}

/** A run that ends without its after-tasks (canceled, manager lost): auto ones will never start. */
function skipAutoTasks(run: Run, reason: string, now: string): void {
  for (const task of run.playbook.after) {
    const state = run.after[task.id];
    if (task.trigger !== "auto" || !state || state.status !== "pending") continue;
    run.after[task.id] = { ...state, status: "canceled", endedAt: now, detail: reason };
  }
}

/** Ends an after-task. The run's status does not change. */
function finishTask(run: Run, taskId: string, status: "completed" | "failed" | "canceled", detail: string, now: string, fx: Effects): void {
  const task = afterTaskDef(run, taskId);
  for (const stepId of task.steps) {
    const state = run.steps[stepId]!;
    if (state.status === "ready" || state.status === "queued") state.status = "pending";
    if (state.status !== "running") continue;
    const attempt = state.attempts.at(-1);
    if (attempt) {
      fx.cancelAgents.push(attempt.agentId);
      attempt.turnEnd = "canceled";
      attempt.endedAt = now;
    }
    state.status = "failed";
    log(run, now, "step_canceled", stepId, detail || `after-task ${status}`);
  }
  archiveEnded(run, task.steps, fx);
  for (const gate of run.gates) {
    if (gate.status === "pending" && task.steps.includes(gate.stepId)) {
      gate.status = "rejected";
      gate.comment = `after-task ${status}`;
      gate.decidedAt = now;
    }
  }
  const state = run.after[taskId]!;
  run.after[taskId] = { ...state, status, endedAt: now, detail: detail || null };
  log(run, now, `after_${status}`, null, `${taskId}${detail ? `: ${detail}` : ""}`);
  fx.notes.push(`After-task "${taskId}" ${status}${detail ? `: ${detail}` : ""}. The run stays ${run.status}.`);
  const still = runningAfterTasks(run);
  fx.notes.push(still.length > 0 ? `After-tasks still running: ${still.join(", ")}.` : "No after-task is running any more.");
}

/** A human starts a `manual` after-task of a finished run. */
export function startAfterTask(run: Run, taskId: string, now: string): Effects {
  const task = afterTaskDef(run, taskId);
  if (!isTerminal(run.status)) throw new EngineError(`run ${run.id} is ${run.status}; after-tasks start once it has ended`);
  if (task.trigger !== "manual") throw new EngineError(`after-task "${taskId}" starts on its own (trigger: auto)`);
  const status = run.after[taskId]?.status ?? "pending";
  if (status !== "pending") throw new EngineError(`after-task "${taskId}" is ${status}; it runs once`);
  // A pause left on the ended run must not hold the task a human starts now.
  run.pausedAt = null;
  const fx = effects();
  const ready = launchTask(run, taskId, now);
  fx.notes.push(afterNote(run, [taskId], ready));
  return fx;
}

function markCompleted(run: Run, stepId: string, now: string, fx: Effects): void {
  setCompleted(run, stepId, now, fx);
  advance(run, stepId, now, fx);
}

function setCompleted(run: Run, stepId: string, now: string, fx: Effects): void {
  const state = run.steps[stepId]!;
  state.status = "completed";
  state.completedSeq = run.seq + 1;
  log(run, now, "step_completed", stepId, state.attempts.at(-1)?.outcome ?? "approved");
  archiveDone(run, stepId, fx);
}

/** A completed step's agents are no longer needed. */
function archiveDone(run: Run, stepId: string, fx: Effects): void {
  if (stepDef(run, stepId).archiveAgents === false) return;
  fx.archiveAgents.push(...run.steps[stepId]!.attempts.map((attempt) => attempt.agentId).filter((agentId) => !isAgentlessAttempt(agentId)));
}

/**
 * The flow these steps belong to ended (completed, failed or canceled): the agents of the
 * ones that did not complete (failed, canceled, or left reported or pending) are no longer
 * needed either. Completed steps archived theirs when they completed.
 */
function archiveEnded(run: Run, stepIds: readonly string[], fx: Effects): void {
  for (const stepId of stepIds) {
    if (run.steps[stepId]!.status !== "completed") archiveDone(run, stepId, fx);
  }
}

/** After a step finished: ends its flow (the run, or its after-task) when all of it is done, else makes the next steps ready. */
function advance(run: Run, stepId: string, now: string, fx: Effects): void {
  const task = stepDef(run, stepId).afterTask;
  const flow = run.playbook.steps.filter((step) => step.afterTask === task);
  if (flow.every((step) => isStepDone(run.steps[step.id]!.status))) {
    if (task) finishTask(run, task, "completed", "", now, fx);
    else completeRun(run, now, fx);
    return;
  }
  const { ready, queued } = refreshReady(run, now);
  // Skipped steps (`when`) may have finished the flow.
  if (flow.every((step) => isStepDone(run.steps[step.id]!.status))) {
    if (task) finishTask(run, task, "completed", "", now, fx);
    else completeRun(run, now, fx);
    return;
  }
  if (ready.length > 0) fx.notes.push(`Ready: ${ready.join(", ")}.`);
  if (queued.length > 0) fx.notes.push(queueNote(run, queued));
}

/**
 * An `end` transition. At top level it completes the run. Inside a sub-playbook block it
 * ends only the innermost block: the step completes, the block's other unfinished steps are
 * skipped (running agents canceled, pending gates closed), and the parent goes on with the
 * steps that need the block. The block's outputs are whatever its completed steps produced.
 * With an `outcome` other than the block's first, the parent step's `on` decides instead:
 * `end` ends the block around it (or the run) in turn, `fail` fails the run.
 */
function endFrom(run: Run, stepId: string, outcome: string | undefined, now: string, fx: Effects): void {
  const step = stepDef(run, stepId);
  const prefix = scopeOf(run, step, stepId);
  if (prefix === null) {
    run.steps[stepId]!.status = "completed";
    archiveDone(run, stepId, fx);
    if (outcome) log(run, now, "run_outcome", stepId, outcome);
    endFlow(run, step, "completed", "", now, fx);
    return;
  }
  setCompleted(run, stepId, now, fx);
  endBlock(run, step, prefix, outcome, `"${stepId}"`, now, fx);
}

/** The block an `end` from `id` (a step, or a block's prefix) ends; null = its whole flow (the run, or its after-task). */
function scopeOf(run: Run, step: Step, id: string): string | null {
  const block = innermostBlock(run.playbook, id);
  // An after-task that is a sub-playbook is a block too: an `end` at its top level ends the task.
  return block === step.afterTask ? null : block;
}

/** Skips the block's unfinished steps, then follows the block's outcome through its parent step's `on`. */
function endBlock(run: Run, step: Step, prefix: string, outcome: string | undefined, by: string, now: string, fx: Effects): void {
  const skipped: string[] = [];
  for (const id of blockStepIds(run.playbook, prefix)) {
    const state = run.steps[id]!;
    if (isStepDone(state.status)) continue;
    if (state.status === "running") {
      const attempt = state.attempts.at(-1);
      if (attempt) {
        fx.cancelAgents.push(attempt.agentId);
        attempt.turnEnd = "canceled";
        attempt.endedAt = now;
      }
    }
    state.status = "skipped";
    state.queuedAt = null;
    state.completedSeq = null;
    skipped.push(id);
    log(run, now, "step_skipped", id, `block "${prefix}" ended by ${by}`);
  }
  for (const gate of run.gates) {
    if (gate.status === "pending" && skipped.includes(gate.stepId)) {
      gate.status = "rejected";
      gate.comment = `block "${prefix}" ended`;
      gate.decidedAt = now;
    }
  }
  const block = run.playbook.blocks[prefix];
  const routed = outcome !== undefined && outcome !== block?.outcomes?.[0];
  fx.notes.push(`${by} ended block "${prefix}"${routed ? ` with "${outcome}"` : ""}${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}.`);
  const transition = routed ? block?.on?.[outcome!] : undefined;
  if (transition?.kind === "end") {
    log(run, now, "block_outcome", null, `${prefix}: ${outcome} → end`);
    const parent = scopeOf(run, step, prefix);
    if (parent !== null) {
      endBlock(run, step, parent, transition.outcome, `block "${prefix}" (${outcome})`, now, fx);
      return;
    }
    if (transition.outcome) log(run, now, "run_outcome", null, transition.outcome);
    endFlow(run, step, "completed", "", now, fx);
    return;
  }
  if (transition?.kind === "fail") {
    log(run, now, "block_outcome", null, `${prefix}: ${outcome} → fail`);
    endFlow(run, step, "failed", `block "${prefix}" ended with "${outcome}"`, now, fx);
    return;
  }
  advance(run, step.id, now, fx);
}

/**
 * A goto from outside a block into it starts the block afresh: the loop counters (and
 * granted allowances) of the transitions inside it go back to 0, so a `max_loops` inside a
 * block holds per pass, not per run. `loopTotals` keeps the cumulative counts.
 */
function resetBlockLoops(run: Run, source: string, target: string): void {
  const parts = target.split(".");
  for (let i = 1; i < parts.length; i++) {
    const prefix = `${parts.slice(0, i).join(".")}.`;
    if (source.startsWith(prefix)) continue;
    for (const counters of [run.loops, run.loopAllowance]) {
      for (const key of Object.keys(counters)) if (key.startsWith(prefix)) delete counters[key];
    }
  }
}

function performGoto(run: Run, source: string, target: string, feedback: string, now: string, fx: Effects): void {
  const key = `${source}->${target}`;
  resetBlockLoops(run, source, target);
  run.loops[key] = (run.loops[key] ?? 0) + 1;
  run.loopTotals[key] = (run.loopTotals[key] ?? 0) + 1;
  const reset = new Set([target, ...descendantsOf(run.playbook.steps, target)]);
  for (const stepId of reset) {
    const state = run.steps[stepId]!;
    if (state.status === "running") {
      const attempt = state.attempts.at(-1);
      if (attempt) {
        fx.cancelAgents.push(attempt.agentId);
        attempt.turnEnd = "canceled";
        attempt.endedAt = now;
      }
    }
    state.status = "pending";
    state.outputs = {};
    state.completedSeq = null;
    state.loop += 1;
  }
  for (const gate of run.gates) {
    if (gate.status === "pending" && reset.has(gate.stepId)) {
      gate.status = "rejected";
      gate.comment = `reset by loop ${key}`;
      gate.decidedAt = now;
    }
  }
  run.steps[target]!.feedback = feedback || null;
  log(run, now, "goto", source, `${key} (loop ${run.loops[key]})`);
  const { ready, queued } = refreshReady(run, now);
  fx.notes.push(`Looping back to "${target}" (loop ${run.loops[key]}). Ready: ${ready.join(", ") || "none"}.`);
  if (queued.length > 0) fx.notes.push(queueNote(run, queued));
}

function gotoOrLimit(run: Run, step: Step, target: string, maxLoops: number | undefined, feedback: string, now: string, fx: Effects, decider?: GateDecider): void {
  const key = `${step.id}->${target}`;
  const limit = maxLoops === undefined ? Infinity : maxLoops + (run.loopAllowance[key] ?? 0);
  if ((run.loops[key] ?? 0) < limit) {
    performGoto(run, step.id, target, feedback, now, fx);
    return;
  }
  run.steps[step.id]!.status = "waiting";
  const gate: Gate = {
    id: `loop-${step.id}-${target}-${run.loops[key] ?? 0}`,
    kind: "loop_limit",
    stepId: step.id,
    gotoTarget: target,
    outcome: null,
    status: "pending",
    message: `Loop limit reached: "${step.id}" → "${target}" ran ${run.loops[key] ?? 0} times (max ${maxLoops}). Approve one more loop, or reject to fail the ${step.afterTask ? "after-task" : "run"}.\n\nLatest feedback: ${feedback || "(none)"}`,
    summary: `Loop limit reached: "${step.id}" → "${target}" ran ${run.loops[key] ?? 0} times (max ${maxLoops}). Approve one more loop, or reject to fail the ${step.afterTask ? "after-task" : "run"}.`,
    details: `Latest feedback: ${feedback || "(none)"}`,
    requestedAt: now,
    comment: feedback || null,
    decidedBy: null,
    decidedVia: null,
    decidedAt: null,
    ...openDecider(decider),
  };
  run.gates.push(gate);
  log(run, now, "gate_opened", step.id, gate.id);
  fx.notes.push(`Loop limit reached for ${key}: a human gate (${gate.id}) is open in the panel. ${askHumanText(gate, choicesOfGate(gate, step))}`);
}

/** A new gate's decider fields: a human unless the playbook names a manager or role decider. */
function openDecider(decider: GateDecider | undefined): Pick<Gate, "decider" | "deciderAgentId" | "escalated" | "escalatedAt"> {
  return { decider: decider ?? { by: "human" }, deciderAgentId: null, escalated: null, escalatedAt: null };
}

/** An `ask` transition: the step waits while a human answers, then goes back to the target with the answer. */
function openAskGate(run: Run, step: Step, outcome: string, transition: Extract<Transition, { kind: "ask" }>, summary: string, now: string, fx: Effects): void {
  run.steps[step.id]!.status = "waiting";
  const asked = run.gates.filter((gate) => gate.kind === "ask" && gate.stepId === step.id).length;
  const gate: Gate = {
    id: `ask-${step.id}-${asked + 1}`,
    kind: "ask",
    stepId: step.id,
    gotoTarget: transition.target,
    outcome,
    status: "pending",
    message: [transition.ask, summary].filter(Boolean).join("\n\n"),
    summary: transition.ask,
    details: summary,
    requestedAt: now,
    comment: null,
    decidedBy: null,
    decidedVia: null,
    decidedAt: null,
    ...openDecider(transition.decider),
  };
  run.gates.push(gate);
  log(run, now, "gate_opened", step.id, gate.id);
  fx.notes.push(`"${step.id}" needs input: a human gate (${gate.id}) is open in the panel. ${askHumanText(gate, choicesOfGate(gate, step))}`);
}

/** The manager's verdict on a reported (or running) agent step. */
export function completeStep(
  run: Run,
  stepId: string,
  input: { outcome: string; summary?: string; outputs?: Record<string, unknown>; now: string },
): Effects {
  assertLive(run, stepId);
  const step = stepDef(run, stepId);
  const state = runStep(run, stepId);
  if (step.kind === "gate") throw new EngineError(`step "${stepId}" is a gate; its outcome comes from a gate decision`);
  if (state.status !== "reported" && state.status !== "running") {
    throw new EngineError(`step "${stepId}" is ${state.status}; only a running or reported step can be completed`);
  }
  if (!step.outcomes.includes(input.outcome)) {
    throw new EngineError(`outcome "${input.outcome}" is not allowed; use one of: ${step.outcomes.join(", ")}`);
  }
  const attempt = state.attempts.at(-1)!;
  const fx = effects();
  const transition = defaultTransition(step, input.outcome);
  const summary = input.summary ?? attempt.report?.summary ?? attempt.lastMessage ?? "";

  if (transition.kind === "complete" || transition.kind === "end" || transition.kind === "goto") {
    const merged = { ...(attempt.report?.outputs ?? {}), ...(input.outputs ?? {}) };
    if (!outputsRequired(step, input.outcome)) {
      state.outputs = partialOutputs(step, merged);
    } else {
      const checked = validateOutputs(step, merged);
      if (!checked.ok) throw new EngineError(`cannot complete "${stepId}": ${checked.errors.join("; ")}`);
      state.outputs = checked.outputs;
    }
  }
  if (state.status === "running") {
    fx.cancelAgents.push(attempt.agentId);
    attempt.turnEnd = attempt.turnEnd ?? "canceled";
    attempt.endedAt = attempt.endedAt ?? input.now;
  }
  attempt.outcome = input.outcome;
  state.summary = summary || null;
  log(run, input.now, "step_outcome", stepId, input.outcome);
  followOutcome(run, step, input.outcome, summary, input.now, fx);
  updateStatus(run);
  return fx;
}

/** Takes the transition of an agent or script step's outcome (from completeStep, or an ask choice with `outcome`). */
function followOutcome(run: Run, step: Step, outcome: string, summary: string, now: string, fx: Effects): void {
  const state = run.steps[step.id]!;
  const transition = defaultTransition(step, outcome);
  switch (transition.kind) {
    case "complete":
      markCompleted(run, step.id, now, fx);
      break;
    case "end":
      endFrom(run, step.id, transition.outcome, now, fx);
      break;
    case "fail":
      state.status = "failed";
      endFlow(run, step, "failed", `step "${step.id}" ended with "${outcome}"`, now, fx);
      break;
    case "retry": {
      const counted = state.attempts.filter((a) => a.turnEnd !== "lost").length;
      if (counted <= step.retries && !state.attempts.at(-1)!.noRetry) {
        state.status = "ready";
        state.feedback = summary ? `Previous attempt failed: ${summary}` : null;
        fx.notes.push(`"${step.id}" failed; retry ${counted}/${step.retries} allowed. Ready: ${readySteps(run).join(", ")}.`);
      } else {
        state.status = "failed";
        endFlow(run, step, "failed", `step "${step.id}" failed after ${counted} attempt(s)`, now, fx);
      }
      break;
    }
    case "goto":
      gotoOrLimit(run, step, transition.target, transition.maxLoops, summary, now, fx, transition.decider);
      break;
    case "ask":
      openAskGate(run, step, outcome, transition, summary, now, fx);
      break;
  }
}

/**
 * The outputs an ask choice with `outcome` sets: its `outputs` templates (over the gate's
 * comment and choice, the step's last report and its inputs) merged over the last report's.
 * Checked like a report when the outcome completes, ends or loops; null otherwise.
 */
function askChoiceOutputs(run: Run, step: Step, choice: AskChoice, comment: string): Record<string, VarValue> | null {
  const attempt = run.steps[step.id]!.attempts.at(-1);
  const report = attempt?.report;
  const context = {
    gate: { comment, choice: choice.id },
    report: { summary: report?.summary ?? run.steps[step.id]!.summary ?? "", outputs: report?.outputs ?? {} },
    inputs: Object.fromEntries(Object.entries(attempt?.inputs ?? {}).map(([name, entry]) => [name, entry.value])),
  };
  const merged: Record<string, unknown> = { ...(report?.outputs ?? {}) };
  for (const [name, template] of Object.entries(choice.outputs ?? {})) {
    const value = resolveValue(template, context);
    merged[name] = value === undefined || value === "" ? "(none)" : value;
  }
  const kind = defaultTransition(step, choice.outcome!).kind;
  if (kind !== "complete" && kind !== "end" && kind !== "goto") return null;
  const checked = validateOutputs(step, merged);
  if (!checked.ok) throw new EngineError(`"${choice.label}" cannot complete "${step.id}": ${checked.errors.join("; ")}`);
  return checked.outputs;
}

/** Opens the human gate of a ready gate step. */
export function requestGate(run: Run, stepId: string, summary: string, now: string, details = ""): Gate {
  assertLive(run, stepId);
  const step = stepDef(run, stepId);
  const state = runStep(run, stepId);
  if (step.kind !== "gate") throw new EngineError(`step "${stepId}" is not a gate`);
  if (state.status !== "ready") throw new EngineError(`gate "${stepId}" is ${state.status}, not ready`);
  const gate: Gate = {
    id: `${stepId}-${state.attempts.length + run.gates.filter((g) => g.stepId === stepId).length + 1}`,
    kind: "gate",
    stepId,
    gotoTarget: null,
    outcome: null,
    status: "pending",
    message: [summary, step.gate, details].filter(Boolean).join("\n\n"),
    summary,
    details: [step.gate, details].filter(Boolean).join("\n\n"),
    requestedAt: now,
    comment: null,
    decidedBy: null,
    decidedVia: null,
    decidedAt: null,
    ...openDecider(step.decider),
  };
  run.gates.push(gate);
  state.status = "waiting";
  log(run, now, "gate_opened", stepId, gate.id);
  updateStatus(run);
  return gate;
}

/** "a human", "the manager" or `role "x"`. */
export function deciderText(decider: GateDecider): string {
  return decider.by === "role" ? `role "${decider.role}"` : decider.by === "manager" ? "the manager" : "a human";
}

/**
 * The manager or role decider of a pending gate leaves it to a human, with its reason: the
 * gate then works as a human gate. Returns false when the gate is no longer pending.
 */
export function escalateGate(run: Run, ref: string, reason: string, now: string): boolean {
  const gate = findGate(run, ref);
  if (!gate || gate.status !== "pending" || gate.escalated !== null) return false;
  gate.escalated = reason.trim() || "no reason given";
  gate.escalatedAt = now;
  const note = `Left to a human by ${deciderText(gate.decider)}: ${gate.escalated}`;
  gate.details = [gate.details, note].filter(Boolean).join("\n\n");
  gate.message = [gate.message, note].filter(Boolean).join("\n\n");
  log(run, now, "gate_escalated", gate.stepId, `${gate.id}: ${gate.escalated}`);
  return true;
}

/** Records the agent a role decider runs as. */
export function startGateDecider(run: Run, gateId: string, agentId: string, now: string): void {
  const gate = run.gates.find((candidate) => candidate.id === gateId);
  if (!gate) return;
  gate.deciderAgentId = agentId;
  log(run, now, "gate_decider_started", gate.stepId, `${gate.id}: ${deciderText(gate.decider)}, agent ${agentId}`);
}

/** Finds the pending gate for a step id or gate id. */
export function findGate(run: Run, ref: string): Gate | null {
  const byId = run.gates.find((gate) => gate.id === ref);
  if (byId) return byId;
  const forStep = run.gates.filter((gate) => gate.stepId === ref);
  return forStep.find((gate) => gate.status === "pending") ?? forStep.at(-1) ?? null;
}

export interface GateDecision {
  /** A choice id of the gate; "approved" / "rejected" for loop-limit gates. */
  decision: string;
  comment: string | null;
  by: string | null;
  via: "panel" | "chat" | "manager" | "role";
  now: string;
}

/** Who took a decision, as the target step reads it: "the human", "the manager" or `the role "x"`. */
function deciderLabel(decision: GateDecision): string {
  return decision.via === "manager" ? "the manager" : decision.via === "role" ? `the role "${decision.by ?? "?"}"` : "the human";
}

/**
 * The feedback a decision passes to the step its goto leads to: the comment, as a human gave it,
 * or told apart when the manager or a role decided. Empty without a comment.
 */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function decisionFeedback(decision: GateDecision): string {
  const comment = decision.comment?.trim() ?? "";
  if (!comment) return "";
  return decision.via === "manager" || decision.via === "role" ? `${deciderLabel(decision)} decided: ${comment}` : comment;
}

/** Records a gate decision. The first decision wins; a second one returns the first. */
export function decideGate(run: Run, ref: string, decision: GateDecision): { gate: Gate; alreadyDecided: boolean; effects: Effects } {
  const gate = findGate(run, ref);
  if (!gate) throw new EngineError(`no gate "${ref}" in run ${run.id}`);
  const fx = effects();
  if (gate.status !== "pending") return { gate, alreadyDecided: true, effects: fx };
  assertLive(run, gate.stepId);
  const choices = choicesOfGate(gate, stepDef(run, gate.stepId));
  const choice = choices.find((candidate) => candidate.id === decision.decision);
  if (!choice) throw new EngineError(`"${decision.decision}" is not a choice of gate "${gate.stepId}" (${choices.map((c) => c.id).join(", ")})`);
  if (choice.comment === "required" && !decision.comment?.trim()) throw new EngineError(`"${choice.label}" needs a comment`);
  if (decision.via === "manager" || decision.via === "role") {
    if (gate.decider.by !== decision.via) throw new EngineError(`gate "${gate.id}" is decided by ${deciderText(gate.decider)}, not by ${decision.via === "manager" ? "you" : "a role"}; ask a human`);
    if (gate.escalated !== null) throw new EngineError(`gate "${gate.id}" was left to a human (${gate.escalated}); ask a human`);
    if (!decision.comment?.trim()) throw new EngineError(`deciding gate "${gate.id}" without a human needs a comment with the reason`);
  }
  // A role agent still deciding stops once someone else decides.
  if (gate.deciderAgentId && decision.via !== "role") fx.archiveAgents.push(gate.deciderAgentId);
  const step = stepDef(run, gate.stepId);
  const ask = gate.kind === "ask" ? askTransitionOf(gate, step) : null;
  const picked = ask ? askChoices(ask).find((candidate) => candidate.id === choice.id) : undefined;
  // Checked before the gate closes: outputs the step lacks refuse the decision.
  const outputs = picked?.outcome !== undefined ? askChoiceOutputs(run, step, picked, decision.comment?.trim() ?? "") : null;
  gate.status = decision.decision;
  gate.comment = decision.comment;
  gate.decidedBy = decision.by;
  gate.decidedVia = decision.via;
  gate.decidedAt = decision.now;
  log(run, decision.now, "gate_decided", gate.stepId, `${gate.id}: ${decision.decision} via ${decision.via}`);
  if (gate.kind === "ask" && picked?.outcome !== undefined) {
    // The step ends with the choice's outcome, as if it had reported it: it does not run again.
    const state = run.steps[gate.stepId]!;
    if (outputs) state.outputs = outputs;
    const attempt = state.attempts.at(-1);
    if (attempt) attempt.outcome = picked.outcome;
    log(run, decision.now, "step_outcome", gate.stepId, `${picked.outcome} (${gate.id}: ${choice.id})`);
    fx.notes.push(`Gate ${gate.id}: the human chose "${choice.id}", so "${gate.stepId}" ends with "${picked.outcome}" without running again.`);
    followOutcome(run, step, picked.outcome, state.summary ?? "", decision.now, fx);
    updateStatus(run);
    return { gate, alreadyDecided: false, effects: fx };
  }
  if (gate.kind === "ask") {
    // Each choice goes to its own target. With declared choices the target also learns which
    // one the human picked; the single default "answered" passes the answer alone.
    const comment = decision.comment?.trim() ?? "";
    const feedback = ask?.choices?.length ? `${capitalized(deciderLabel(decision))} answered "${choice.id}"${comment ? `: ${comment}` : "."}` : decisionFeedback(decision);
    gotoOrLimit(run, step, picked?.target ?? gate.gotoTarget!, picked?.maxLoops, feedback, decision.now, fx, ask?.decider);
    updateStatus(run);
    return { gate, alreadyDecided: false, effects: fx };
  }
  if (gate.kind === "loop_limit") {
    if (decision.decision === "approved") {
      const key = `${gate.stepId}->${gate.gotoTarget}`;
      run.loopAllowance[key] = (run.loopAllowance[key] ?? 0) + 1;
      // The step's last feedback, then the decision's comment: the target addresses both.
      const latest = run.steps[gate.stepId]!.summary ?? "";
      const comment = decision.comment?.trim();
      const said = comment ? `On the loop limit, ${deciderLabel(decision)} said: ${comment}` : "";
      performGoto(run, gate.stepId, gate.gotoTarget!, [latest, said].filter(Boolean).join("\n\n"), decision.now, fx);
    } else {
      run.steps[gate.stepId]!.status = "failed";
      endFlow(run, step, "failed", `loop limit for "${gate.stepId}" → "${gate.gotoTarget}" rejected`, decision.now, fx);
    }
    updateStatus(run);
    return { gate, alreadyDecided: false, effects: fx };
  }
  const state = run.steps[gate.stepId]!;
  state.summary = decision.comment;
  const transition = defaultTransition(step, decision.decision);
  switch (transition.kind) {
    case "complete":
      markCompleted(run, gate.stepId, decision.now, fx);
      break;
    case "end":
      endFrom(run, gate.stepId, transition.outcome, decision.now, fx);
      break;
    case "goto":
      gotoOrLimit(run, step, transition.target, transition.maxLoops, decisionFeedback(decision), decision.now, fx, transition.decider);
      break;
    default:
      state.status = "failed";
      endFlow(run, step, "failed", `gate "${gate.stepId}" ${decision.decision}${decision.comment ? `: ${decision.comment}` : ""}`, decision.now, fx);
  }
  updateStatus(run);
  return { gate, alreadyDecided: false, effects: fx };
}

/**
 * Cancels the run and returns the agents to interrupt. While after-tasks run (the run has
 * ended), cancels them instead: the run's status does not change.
 */
export function cancelRun(run: Run, reason: string, now: string): Effects {
  const fx = effects();
  run.pausedAt = null;
  if (!isTerminal(run.status)) {
    finish(run, "canceled", reason, now, fx);
    skipAutoTasks(run, "the run was canceled", now);
    return fx;
  }
  const running = runningAfterTasks(run);
  if (running.length === 0) throw new EngineError(`run ${run.id} is ${run.status}`);
  for (const taskId of running) finishTask(run, taskId, "canceled", reason, now, fx);
  return fx;
}

/**
 * A human reopens a finished run from a step (see `restartBlocker`). The step and everything
 * downstream of it go back to pending, and so does every other main step that had not
 * finished (a parallel branch cut short by the cancel); completed steps elsewhere keep their
 * outputs. The run is running again, with no result, and its after-tasks are pending again
 * (they run once more when it ends). Loop counts are kept, so loop limits still apply.
 * An archived run is unarchived.
 */
export function restartRun(run: Run, stepId: string, input: { comment: string | null; by: string | null; now: string }): Effects {
  const blocker = restartBlocker(run, stepId);
  if (blocker) throw new EngineError(blocker);
  const fx = effects();
  const { now } = input;
  const reset = new Set([stepId, ...descendantsOf(run.playbook.steps.filter((step) => !step.afterTask), stepId)]);
  for (const step of run.playbook.steps) {
    if (step.afterTask) continue;
    const state = run.steps[step.id]!;
    if (!reset.has(step.id) && isStepDone(state.status)) continue;
    state.status = "pending";
    state.outputs = {};
    state.completedSeq = null;
    state.queuedAt = null;
  }
  run.steps[stepId]!.feedback = input.comment?.trim() ? `Restarted from this step by a human: ${input.comment.trim()}` : null;
  for (const task of run.playbook.after) {
    run.after[task.id] = { status: "pending", startedAt: null, endedAt: null, detail: null };
  }
  const previous = run.status;
  run.status = "running";
  run.failure = null;
  run.outputs = null;
  run.pausedAt = null;
  run.archivedAt = null;
  run.seenAt = null;
  log(run, now, "run_restarted", stepId, `was ${previous}${input.by ? `, by ${input.by}` : ""}${input.comment?.trim() ? `: ${input.comment.trim()}` : ""}`);
  const { ready, queued } = refreshReady(run, now);
  fx.notes.push(`The run (was ${previous}) restarted from "${stepId}". Ready: ${ready.join(", ") || "none"}.`);
  if (queued.length > 0) fx.notes.push(queueNote(run, queued));
  updateStatus(run);
  return fx;
}

/** Stops the run for good (e.g. the manager was lost): fails it, or cancels its running after-tasks. No after-task starts. */
export function failRun(run: Run, reason: string, now: string): Effects {
  const fx = effects();
  run.pausedAt = null;
  if (!isTerminal(run.status)) {
    finish(run, "failed", reason, now, fx);
    skipAutoTasks(run, reason, now);
  }
  for (const taskId of runningAfterTasks(run)) finishTask(run, taskId, "canceled", reason, now, fx);
  return fx;
}

/**
 * Pauses the run (drain): no step starts and the manager is not woken until resume. Steps
 * already running finish their turn; their reports wait in the inbox. Returns false if it
 * was already paused.
 */
export function pauseRun(run: Run, now: string): boolean {
  if (!isActive(run)) throw new EngineError(`run ${run.id} is ${run.status}; only an active run can be paused`);
  if (isPaused(run)) return false;
  run.pausedAt = now;
  log(run, now, "run_paused", null, "paused by a human");
  return true;
}

/** Lifts a pause. Returns false if the run was not paused. */
export function resumeRun(run: Run, now: string): boolean {
  if (!isPaused(run)) {
    run.pausedAt = null;
    return false;
  }
  run.pausedAt = null;
  log(run, now, "run_resumed", null, "resumed by a human");
  return true;
}

/** Marks a failed or timed-out readonly check on the current attempt. */
export function markReadonlyViolation(run: Run, stepId: string, detail: string, now: string, kind: "readonly" | "isolation" = "readonly"): void {
  const attempt = currentAttempt(run, stepId);
  if (!attempt) return;
  if (kind === "isolation") {
    attempt.report = { outcome: "failure", summary: `isolation guard: the step changed the workspace checkout instead of the run's worktree (${run.worktree?.path ?? "?"}): ${detail}`, outputs: {} };
    log(run, now, "isolation_violation", stepId, detail);
    return;
  }
  attempt.report = { outcome: "failure", summary: `readonly role modified the checkout: ${detail}`, outputs: {} };
  log(run, now, "readonly_violation", stepId, detail);
}

/** Where the run's agents work: its private worktree, else the workspace checkout. */
export function workDir(run: Pick<Run, "worktree" | "workspaceDir">): string {
  return run.worktree?.path ?? run.workspaceDir;
}

/** Hands the run to another manager agent (its previous one was archived with its parent). */
/** A daemon restart cut the step's turn; the plugin asked the same agent to carry on. */
export function markResumed(run: Run, stepId: string, now: string): void {
  log(run, now, "step_resumed", stepId, "resumed in its conversation after a daemon restart");
}

export function replaceManager(run: Run, managerAgentId: string, reason: string, now: string): void {
  const previous = run.managerAgentId;
  run.managerAgentId = managerAgentId;
  log(run, now, "manager_replaced", null, `${previous} → ${managerAgentId}: ${reason}`);
}

/** Moves a run to another workspace (its own is gone or busy); completed steps keep their outputs. */
export function moveRun(run: Run, to: { id: string; dir: string; branch: string | null }, now: string): void {
  log(run, now, "run_moved", null, `${run.workspaceId} (${run.workspaceDir}) → ${to.id} (${to.dir})${to.branch && to.branch !== run.branch ? `; branch ${run.branch ?? "(none)"} → ${to.branch}` : ""}`);
  run.workspaceId = to.id;
  run.workspaceDir = to.dir;
  run.branch = to.branch;
  // The target workspace is the caller's: the plugin never archives it.
  run.workspaceCreated = false;
}

// ---------------------------------------------------------------- singleton pipelines and jobs

/** A train's open jobs, as its steps read them: `{{ run.jobs }}` (YAML), `PLAYBOOK_JOBS` (JSON). */
export function openJobs(run: Run): Array<{ id: string; from: string; detached?: true; inputs: Record<string, VarValue>; outputs: Record<string, VarValue> }> {
  return run.jobs
    .filter((job) => job.status === "open")
    .map((job) => ({ id: job.id, from: job.label, ...(job.detached ? { detached: true as const } : {}), inputs: job.inputs, outputs: job.outputs }));
}

export function jobsText(run: Run): string {
  const jobs = openJobs(run);
  return jobs.length === 0 ? "" : toYaml(jobs).trimEnd();
}

export function stationsOf(pipeline: Run) {
  return pipeline.playbook.singleton?.stations ?? [];
}

/** Puts a job on the waiting lists of the stations it may enter now (all needs passed, not there yet). */
function queueNext(pipeline: Run, job: Job, now: string): void {
  for (const station of stationsOf(pipeline)) {
    if (job.passed.includes(station.id) || job.waiting.some((entry) => entry.station === station.id) || job.riding.some((entry) => entry.station === station.id)) continue;
    if (station.needs.every((need) => job.passed.includes(need))) job.waiting.push({ station: station.id, since: now });
  }
}

/** A hand-off's job joins the pipeline: it waits at the stations with no needs. */
export function addJob(pipeline: Run, job: Job, now: string): void {
  if (!isPipeline(pipeline) || isTerminal(pipeline.status)) throw new EngineError(`run ${pipeline.id} is not an active pipeline`);
  pipeline.jobs.push(job);
  queueNext(pipeline, job, now);
  log(pipeline, now, "job_queued", null, `${job.id} from ${job.fromRunId}/${job.fromStepId} at ${job.waiting.map((entry) => entry.station).join(", ")}`);
}

/** The jobs a station's next train takes: the oldest alone (fifo), or every waiting one (merge). */
export function nextTrainJobs(pipeline: Run, stationId: string): Job[] {
  const station = stationsOf(pipeline).find((candidate) => candidate.id === stationId);
  if (!station) return [];
  const since = (job: Job) => job.waiting.find((entry) => entry.station === stationId)!.since;
  const waiting = pipeline.jobs
    .filter((job) => job.status === "open" && job.waiting.some((entry) => entry.station === stationId))
    .sort((a, b) => since(a).localeCompare(since(b)) || a.createdAt.localeCompare(b.createdAt));
  return station.mode === "merge" ? waiting : waiting.slice(0, 1);
}

/** The jobs board a train: they leave the station's waiting list and ride the train run. */
export function boardTrain(pipeline: Run, stationId: string, trainRunId: string, jobIds: string[], now: string): void {
  for (const job of pipeline.jobs.filter((candidate) => jobIds.includes(candidate.id))) {
    const entry = job.waiting.find((candidate) => candidate.station === stationId);
    job.waiting = job.waiting.filter((candidate) => candidate.station !== stationId);
    job.riding.push({ station: stationId, runId: trainRunId, since: entry?.since ?? now });
  }
  log(pipeline, now, "train_departed", stationId, `${trainRunId} with ${jobIds.join(", ")}`);
}

/** A station's train: an ordinary run of the station's steps, carrying copies of its jobs. */
export function newTrainRun(input: {
  id: string;
  pipeline: Run;
  station: string;
  jobs: Job[];
  managerAgentId: string;
  now: string;
}): Run {
  const playbook = stationPlaybook(input.pipeline.playbook, input.station);
  const run = createRun(
    {
      id: input.id,
      playbook,
      workspaceId: input.pipeline.workspaceId,
      workspaceDir: input.pipeline.workspaceDir,
      projectId: input.pipeline.projectId,
      branch: input.pipeline.branch,
      managerAgentId: input.managerAgentId,
      inputs: {},
      now: input.now,
    },
    {},
    "run",
  );
  run.train = { pipelineId: input.pipeline.id, playbook: input.pipeline.playbook.id, station: input.station };
  run.jobs = input.jobs.map((job) => ({ ...structuredClone(job), waiting: [], riding: [] }));
  return run;
}

function endJob(run: Run, job: Job, status: Job["status"], outcome: string | null, summary: string, outputs: Record<string, VarValue>, now: string): void {
  job.status = status;
  job.outcome = outcome;
  job.summary = summary || null;
  job.outputs = { ...job.outputs, ...outputs };
  job.endedAt = now;
  job.waiting = [];
  log(run, now, `job_${status}`, null, `${job.id}${outcome ? `: ${outcome}` : ""}${summary ? ` (${summary.slice(0, 200)})` : ""}`);
}

/** Checks outputs against the singleton's declared types; `all` requires every one of them. */
function checkJobOutputs(playbook: Playbook, outputs: Record<string, unknown>, all: boolean): { ok: true; outputs: Record<string, VarValue> } | { ok: false; errors: string[] } {
  const result: Record<string, VarValue> = {};
  const errors: string[] = [];
  for (const [name, def] of Object.entries(playbook.outputs)) {
    const raw = outputs[name];
    if (raw === undefined || raw === null || raw === "") {
      if (all) errors.push(`missing output "${name}" (${def.type})`);
      continue;
    }
    const coerced = coerceValue(def, raw);
    if (coerced.ok) result[name] = coerced.value;
    else errors.push(`output "${name}": ${coerced.error}`);
  }
  for (const name of Object.keys(outputs)) {
    if (!playbook.outputs[name]) errors.push(`unknown output "${name}" (declared: ${Object.keys(playbook.outputs).join(", ") || "none"})`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, outputs: result };
}

/**
 * A train's manager settles one of its jobs. Without an outcome, the job's outputs are set and
 * it goes on. With an outcome of the singleton, the job ends now (all outputs required for the
 * first outcome). Applied to the pipeline; the runtime mirrors it on the train's copy.
 */
export function settleJob(
  pipeline: Run,
  trainRunId: string,
  jobId: string,
  input: { outcome?: string | undefined; summary: string; outputs: Record<string, unknown>; now: string },
): { job: Job; ended: boolean } {
  const job = pipeline.jobs.find((candidate) => candidate.id === jobId);
  if (!job || !job.riding.some((entry) => entry.runId === trainRunId)) {
    throw new EngineError(`job "${jobId}" is not on this train (its jobs: ${pipeline.jobs.filter((candidate) => candidate.riding.some((entry) => entry.runId === trainRunId)).map((candidate) => candidate.id).join(", ") || "none"})`);
  }
  if (job.status !== "open") throw new EngineError(`job ${jobId} is already ${job.status}${job.outcome ? ` (${job.outcome})` : ""}`);
  const outcomes = pipeline.playbook.outcomes;
  if (input.outcome !== undefined && !outcomes.includes(input.outcome)) {
    throw new EngineError(`outcome "${input.outcome}" is not an outcome of "${pipeline.playbook.id}"; use one of: ${outcomes.join(", ")}, or none to only set outputs`);
  }
  const services = job.inputs.services;
  if (input.outcome === "no_deploy" && services !== undefined && String(services).trim() !== "" && String(services).trim().toLowerCase() !== "none") {
    throw new EngineError(`job ${jobId} cannot be settled no_deploy: its services are "${services}", and no_deploy is only for a job whose services is none. Send the step back, or settle it without an outcome to keep it riding`);
  }
  const checked = checkJobOutputs(pipeline.playbook, { ...(input.outcome === outcomes[0] ? job.outputs : {}), ...input.outputs }, input.outcome === outcomes[0]);
  if (!checked.ok) throw new EngineError(`cannot settle job ${jobId}: ${checked.errors.join("; ")}`);
  if (input.outcome === undefined) {
    job.outputs = { ...job.outputs, ...checked.outputs };
    log(pipeline, input.now, "job_outputs", null, `${jobId}: ${Object.keys(checked.outputs).join(", ") || "none"}`);
    return { job, ended: false };
  }
  endJob(pipeline, job, "settled", input.outcome, input.summary, checked.outputs, input.now);
  return { job, ended: true };
}

/** One entry of a step's `settle` output: a job's outputs and, for a job that ends now, its outcome. */
export interface JobResult {
  jobId: string;
  outcome?: string | undefined;
  summary: string;
  outputs: Record<string, unknown>;
}

/**
 * Reads a step's `settle` output: YAML with, per job id, `outputs` and optionally `outcome`
 * and `reason`. Empty, `none` or `{}` settles nothing; YAML comments are ignored.
 */
export function parseJobResults(text: string): JobResult[] {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "{}" || trimmed.toLowerCase() === "none") return [];
  let data: unknown;
  try {
    data = parseYaml(trimmed);
  } catch (error) {
    throw new EngineError(`not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (data === null || data === undefined) return [];
  if (typeof data !== "object" || Array.isArray(data)) throw new EngineError("expected a mapping of job ids, e.g. `job_ab12: { outputs: { report: ... } }`");
  return Object.entries(data as Record<string, unknown>).map(([jobId, entry]) => {
    if (entry === null || entry === undefined) return { jobId, summary: "", outputs: {} };
    if (typeof entry !== "object" || Array.isArray(entry)) throw new EngineError(`job ${jobId}: expected { outputs, outcome, reason }`);
    const { outputs, outcome, reason, ...rest } = entry as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) throw new EngineError(`job ${jobId}: unknown key(s) ${unknown.join(", ")} (use outputs, outcome, reason)`);
    if (outputs !== undefined && outputs !== null && (typeof outputs !== "object" || Array.isArray(outputs))) throw new EngineError(`job ${jobId}: outputs must be a mapping`);
    if (outcome !== undefined && outcome !== null && typeof outcome !== "string") throw new EngineError(`job ${jobId}: outcome must be a string`);
    return { jobId, outcome: (outcome as string | null | undefined) ?? undefined, summary: typeof reason === "string" ? reason : "", outputs: (outputs ?? {}) as Record<string, unknown> };
  });
}

/**
 * The jobs that would leave the pipeline without a required output if this train completed now:
 * open jobs that, with this train, have passed every station. `pipeline` is a copy with the
 * step's settle entries applied. Returns problems, one per job and output.
 */
export function jobsMissingOutputs(pipeline: Run, train: Run): string[] {
  const stationId = train.train!.station;
  const problems: string[] = [];
  for (const job of pipeline.jobs) {
    if (job.status !== "open" || !job.riding.some((entry) => entry.runId === train.id)) continue;
    const others = job.riding.some((entry) => entry.runId !== train.id);
    const passed = new Set([...job.passed, stationId]);
    if (others || job.waiting.length > 0 || !stationsOf(pipeline).every((candidate) => passed.has(candidate.id))) continue;
    const copy = train.jobs.find((candidate) => candidate.id === job.id);
    const checked = checkJobOutputs(pipeline.playbook, { ...(copy?.outputs ?? {}), ...job.outputs }, true);
    if (!checked.ok) for (const error of checked.errors) problems.push(`job ${job.id}: ${error}`);
  }
  return problems;
}

/** True when this outcome completes the step (complete, end or goto): its outputs then count. */
export function completesStep(step: Step, outcome: string): boolean {
  const kind = defaultTransition(step, outcome).kind;
  return kind === "complete" || kind === "end" || kind === "goto";
}

/**
 * A train has ended. Its jobs still open: on completion they pass the station and wait at the
 * next ones, or leave the pipeline (settled with the first outcome, once every output is set);
 * on failure they wait at the station again, at the front, while its `retries` allow, else
 * fail; on cancel they fail. Returns the jobs that ended, for their hand-offs.
 */
export function trainEnded(pipeline: Run, train: Run, now: string): Job[] {
  const stationId = train.train!.station;
  const station = stationsOf(pipeline).find((candidate) => candidate.id === stationId);
  const ended: Job[] = [];
  for (const job of pipeline.jobs) {
    const ride = job.riding.find((entry) => entry.runId === train.id);
    if (!ride) continue;
    job.riding = job.riding.filter((entry) => entry.runId !== train.id);
    if (job.status !== "open") continue;
    const copy = train.jobs.find((candidate) => candidate.id === job.id);
    if (copy) job.outputs = { ...job.outputs, ...copy.outputs };
    if (train.status === "completed") {
      job.passed.push(stationId);
      queueNext(pipeline, job, now);
      if (job.waiting.length === 0 && job.riding.length === 0 && stationsOf(pipeline).every((candidate) => job.passed.includes(candidate.id))) {
        const checked = checkJobOutputs(pipeline.playbook, job.outputs, true);
        if (checked.ok) endJob(pipeline, job, "settled", pipeline.playbook.outcomes[0]!, `passed every station`, checked.outputs, now);
        else endJob(pipeline, job, "failed", null, `passed every station but left the pipeline without its outputs: ${checked.errors.join("; ")}. Its work shipped: do not hand it off again`, {}, now);
        ended.push(job);
      }
      continue;
    }
    const rides = (job.failedRides[stationId] ?? 0) + 1;
    job.failedRides[stationId] = rides;
    if (train.status === "failed" && station && rides <= station.retries) {
      // Back at the front: it keeps the place it had in the waiting list.
      job.waiting.push({ station: stationId, since: ride.since });
      log(pipeline, now, "job_requeued", stationId, `${job.id} after train ${train.id} ${train.status} (${rides}/${station.retries})`);
      continue;
    }
    endJob(pipeline, job, "failed", null, `train ${train.id} at "${stationId}" ${train.status}${train.failure ? `: ${train.failure}` : ""}`, {}, now);
    ended.push(job);
  }
  log(pipeline, now, "train_ended", stationId, `${train.id} ${train.status}`);
  return ended;
}

/** A hand-off was canceled, reset or timed out: its job leaves the pipeline. Returns it and the trains carrying it. */
export function withdrawJob(pipeline: Run, jobId: string, reason: string, now: string): { job: Job; trains: string[] } | null {
  const job = pipeline.jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.status !== "open") return null;
  const trains = job.riding.map((entry) => entry.runId);
  job.riding = [];
  endJob(pipeline, job, "withdrawn", null, reason, {}, now);
  return { job, trains };
}

/** The pipeline was canceled or failed: every open job fails. Returns them. */
export function failOpenJobs(run: Run, reason: string, now: string): Job[] {
  return failJobs(run, run.jobs.filter((job) => job.status === "open").map((job) => job.id), reason, now);
}

/** These open jobs fail (e.g. their station was removed from the playbook). Returns them. */
export function failJobs(run: Run, jobIds: string[], reason: string, now: string): Job[] {
  const open = run.jobs.filter((job) => job.status === "open" && jobIds.includes(job.id));
  for (const job of open) {
    job.riding = [];
    endJob(run, job, "failed", null, reason, {}, now);
  }
  return open;
}

/** Mirrors on a train's copy what happened to a job in the pipeline. */
export function mirrorJob(train: Run, job: Job): void {
  const copy = train.jobs.find((candidate) => candidate.id === job.id);
  if (!copy) return;
  copy.status = job.status;
  copy.outcome = job.outcome;
  copy.summary = job.summary;
  copy.outputs = { ...job.outputs };
  copy.endedAt = job.endedAt;
}

/**
 * The result of a hand-off reaches its step: recorded as the attempt's report, and the step
 * moves to reported (the runtime then completes it, or waits while the run is paused).
 */
export function receiveJobResult(run: Run, stepId: string, attemptId: string, result: { outcome: string; summary: string; outputs: Record<string, unknown> }, now: string, noRetry = false): boolean {
  const state = run.steps[stepId];
  const attempt = state?.attempts.at(-1);
  if (!state || attempt?.agentId !== attemptId || state.status !== "running") return false;
  attempt.noRetry = noRetry;
  try {
    recordReport(run, attemptId, result, now);
  } catch (error) {
    recordReport(run, attemptId, { outcome: "failure", summary: `${result.summary} (result refused: ${(error as Error).message})`, outputs: {} }, now);
  }
  endTurn(run, attemptId, { turnEnd: "completed", lastMessage: attempt.lastMessage, now });
  return true;
}
