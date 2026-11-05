/**
 * Pure run-state transitions. Nothing here talks to Paseo or the filesystem: the runtime
 * applies the returned effects (cancel agents, wake the manager).
 */
import { descendantsOf } from "../shared/graph";
import { blockEntrySteps, blockStepIds, holdsBlock, innermostBlock } from "../shared/slots";
import { askChoices, askHumanText, askTransitionOf, choicesOfGate, outcomeTransition } from "../shared/gates";
import type { AfterTask, Attempt, Gate, Playbook, Run, RunStep, Step, Transition, VarValue } from "../shared/types";
import { isActive, isPaused, isStepDone, isStepLive, isTerminal, restartBlocker, runningAfterTasks } from "../shared/types";
import { coerceValue, formatValue, renderTemplate, resolveValue } from "../shared/vars";

export class EngineError extends Error {}

export interface Effects {
  /** Step agents whose running turn must be interrupted. */
  cancelAgents: string[];
  /** Human-readable lines for the manager. */
  notes: string[];
}

function effects(): Effects {
  return { cancelAgents: [], notes: [] };
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

export function newRun(input: NewRunInput): Run {
  const resolved = resolveRunInputs(input.playbook, input.inputs);
  if (!resolved.ok) throw new EngineError(resolved.errors.join("; "));
  const run: Run = {
    version: 1,
    id: input.id,
    playbook: input.playbook,
    workspaceId: input.workspaceId,
    workspaceDir: input.workspaceDir,
    projectId: input.projectId,
    branch: input.branch,
    managerAgentId: input.managerAgentId,
    inputs: resolved.inputs,
    outputs: null,
    status: "running",
    failure: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    seenAt: null,
    pausedAt: null,
    steps: Object.fromEntries(
      input.playbook.steps.map((step) => [
        step.id,
        { status: "pending", attempts: [], outputs: {}, summary: null, feedback: null, completedSeq: null, queuedAt: null },
      ]),
    ),
    loops: {},
    loopAllowance: {},
    gates: [],
    after: Object.fromEntries(
      input.playbook.after.map((task) => [task.id, { status: "pending", startedAt: null, endedAt: null, detail: null }]),
    ),
    inbox: [],
    history: [],
    seq: 0,
  };
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
  const limited = Object.entries(run.playbook.blocks).filter(([, block]) => block.concurrency !== undefined);
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

/** Ready steps that can start now (a finished run's leftover ready steps are not listed). */
export function readySteps(run: Run): string[] {
  return run.playbook.steps.filter((step) => run.steps[step.id]!.status === "ready" && isStepLive(run, step.id)).map((step) => step.id);
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
  if (step.kind !== "agent") throw new EngineError(`step "${stepId}" is a gate; call request_gate`);
  if (isPaused(run)) {
    throw new EngineError(`run ${run.id} is paused by a human: no step starts until it is resumed. End your turn; you are woken on resume.`);
  }
  if (state.status !== "ready") {
    throw new EngineError(`step "${stepId}" is ${state.status}, not ready (ready now: ${readySteps(run).join(", ") || "none"})`);
  }
  const values = stepInputs(run, step);
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
  };
  const context = {
    inputs: Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, entry.value])),
    run: { id: run.id, status: run.status, failure: run.failure },
    attempt: n,
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
    if (!step.outputs[name]) errors.push(`unknown output "${name}" (declared: ${Object.keys(step.outputs).join(", ") || "none"})`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, outputs: result };
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
  // A failure, or a question for a human (`ask`), is not a result: no outputs expected.
  if (report.outcome !== "failure" && defaultTransition(step, report.outcome).kind !== "ask") {
    const checked = validateOutputs(step, report.outputs);
    if (!checked.ok) throw new EngineError(`report refused: ${checked.errors.join("; ")}. Fix these and call report_step_result again.`);
    outputs = checked.outputs;
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

function defaultTransition(step: Step, outcome: string) {
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
  const state = run.steps[stepId]!;
  state.status = "completed";
  state.completedSeq = run.seq + 1;
  log(run, now, "step_completed", stepId, state.attempts.at(-1)?.outcome ?? "approved");
  const task = stepDef(run, stepId).afterTask;
  const flow = run.playbook.steps.filter((step) => step.afterTask === task);
  if (flow.every((step) => isStepDone(run.steps[step.id]!.status))) {
    if (task) finishTask(run, task, "completed", "", now, fx);
    else completeRun(run, now, fx);
    return;
  }
  const { ready, queued } = refreshReady(run, now);
  if (ready.length > 0) fx.notes.push(`Ready: ${ready.join(", ")}.`);
  if (queued.length > 0) fx.notes.push(queueNote(run, queued));
}

/**
 * An `end` transition. At top level it completes the run. Inside a sub-playbook block it
 * ends only the innermost block: the step completes, the block's other unfinished steps are
 * skipped (running agents canceled, pending gates closed), and the parent goes on with the
 * steps that need the block. The block's outputs are whatever its completed steps produced.
 */
function endFrom(run: Run, stepId: string, now: string, fx: Effects): void {
  const step = stepDef(run, stepId);
  const block = innermostBlock(run.playbook, stepId);
  // An after-task that is a sub-playbook is a block too: an `end` at its top level ends the task.
  const prefix = block === step.afterTask ? null : block;
  if (prefix === null) {
    run.steps[stepId]!.status = "completed";
    endFlow(run, step, "completed", "", now, fx);
    return;
  }
  const skipped: string[] = [];
  for (const id of blockStepIds(run.playbook, prefix)) {
    const state = run.steps[id]!;
    if (id === stepId || isStepDone(state.status)) continue;
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
    log(run, now, "step_skipped", id, `block "${prefix}" ended by "${stepId}"`);
  }
  for (const gate of run.gates) {
    if (gate.status === "pending" && skipped.includes(gate.stepId)) {
      gate.status = "rejected";
      gate.comment = `block "${prefix}" ended`;
      gate.decidedAt = now;
    }
  }
  fx.notes.push(`"${stepId}" ended block "${prefix}"${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}.`);
  markCompleted(run, stepId, now, fx);
}

function performGoto(run: Run, source: string, target: string, feedback: string, now: string, fx: Effects): void {
  const key = `${source}->${target}`;
  run.loops[key] = (run.loops[key] ?? 0) + 1;
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

function gotoOrLimit(run: Run, step: Step, target: string, maxLoops: number | undefined, feedback: string, now: string, fx: Effects): void {
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
  };
  run.gates.push(gate);
  log(run, now, "gate_opened", step.id, gate.id);
  fx.notes.push(`Loop limit reached for ${key}: a human gate (${gate.id}) is open in the panel. ${askHumanText(gate, choicesOfGate(gate, step))}`);
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
  if (step.kind !== "agent") throw new EngineError(`step "${stepId}" is a gate; its outcome comes from a gate decision`);
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
    const checked = validateOutputs(step, merged);
    if (!checked.ok) throw new EngineError(`cannot complete "${stepId}": ${checked.errors.join("; ")}`);
    state.outputs = checked.outputs;
  }
  if (state.status === "running") {
    fx.cancelAgents.push(attempt.agentId);
    attempt.turnEnd = attempt.turnEnd ?? "canceled";
    attempt.endedAt = attempt.endedAt ?? input.now;
  }
  attempt.outcome = input.outcome;
  state.summary = summary || null;
  log(run, input.now, "step_outcome", stepId, input.outcome);

  switch (transition.kind) {
    case "complete":
      markCompleted(run, stepId, input.now, fx);
      break;
    case "end":
      endFrom(run, stepId, input.now, fx);
      break;
    case "fail":
      state.status = "failed";
      endFlow(run, step, "failed", `step "${stepId}" ended with "${input.outcome}"`, input.now, fx);
      break;
    case "retry": {
      const counted = state.attempts.filter((a) => a.turnEnd !== "lost").length;
      if (counted <= step.retries) {
        state.status = "ready";
        state.feedback = summary ? `Previous attempt failed: ${summary}` : null;
        fx.notes.push(`"${stepId}" failed; retry ${counted}/${step.retries} allowed. Ready: ${readySteps(run).join(", ")}.`);
      } else {
        state.status = "failed";
        endFlow(run, step, "failed", `step "${stepId}" failed after ${counted} attempt(s)`, input.now, fx);
      }
      break;
    }
    case "goto":
      gotoOrLimit(run, step, transition.target, transition.maxLoops, summary, input.now, fx);
      break;
    case "ask":
      openAskGate(run, step, input.outcome, transition, summary, input.now, fx);
      break;
  }
  updateStatus(run);
  return fx;
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
  };
  run.gates.push(gate);
  state.status = "waiting";
  log(run, now, "gate_opened", stepId, gate.id);
  updateStatus(run);
  return gate;
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
  via: "panel" | "chat";
  now: string;
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
  gate.status = decision.decision;
  gate.comment = decision.comment;
  gate.decidedBy = decision.by;
  gate.decidedVia = decision.via;
  gate.decidedAt = decision.now;
  log(run, decision.now, "gate_decided", gate.stepId, `${gate.id}: ${decision.decision} via ${decision.via}`);
  const step = stepDef(run, gate.stepId);
  if (gate.kind === "ask") {
    // Each choice goes to its own target. With declared choices the target also learns which
    // one the human picked; the single default "answered" passes the answer alone.
    const ask = askTransitionOf(gate, step);
    const picked = ask ? askChoices(ask).find((candidate) => candidate.id === choice.id) : undefined;
    const comment = decision.comment?.trim() ?? "";
    const feedback = ask?.choices?.length ? `The human answered "${choice.id}"${comment ? `: ${comment}` : "."}` : decision.comment ?? "";
    gotoOrLimit(run, step, picked?.target ?? gate.gotoTarget!, picked?.maxLoops, feedback, decision.now, fx);
    updateStatus(run);
    return { gate, alreadyDecided: false, effects: fx };
  }
  if (gate.kind === "loop_limit") {
    if (decision.decision === "approved") {
      const key = `${gate.stepId}->${gate.gotoTarget}`;
      run.loopAllowance[key] = (run.loopAllowance[key] ?? 0) + 1;
      performGoto(run, gate.stepId, gate.gotoTarget!, run.steps[gate.stepId]!.summary ?? decision.comment ?? "", decision.now, fx);
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
      endFrom(run, gate.stepId, decision.now, fx);
      break;
    case "goto":
      gotoOrLimit(run, step, transition.target, transition.maxLoops, decision.comment ?? "", decision.now, fx);
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
export function markReadonlyViolation(run: Run, stepId: string, detail: string, now: string): void {
  const attempt = currentAttempt(run, stepId);
  if (!attempt) return;
  attempt.report = { outcome: "failure", summary: `readonly role modified the checkout: ${detail}`, outputs: {} };
  log(run, now, "readonly_violation", stepId, detail);
}

/** Hands the run to another manager agent (its previous one was archived with its parent). */
export function replaceManager(run: Run, managerAgentId: string, reason: string, now: string): void {
  const previous = run.managerAgentId;
  run.managerAgentId = managerAgentId;
  log(run, now, "manager_replaced", null, `${previous} → ${managerAgentId}: ${reason}`);
}
