/**
 * Pure run-state transitions. Nothing here talks to Paseo or the filesystem: the runtime
 * applies the returned effects (cancel agents, wake the manager).
 */
import { descendantsOf } from "../shared/graph";
import { gateChoices, LOOP_LIMIT_CHOICES, outcomeTransition } from "../shared/gates";
import type { Attempt, Gate, Playbook, Run, RunStep, Step, VarValue } from "../shared/types";
import { isTerminal } from "../shared/types";
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

function assertActive(run: Run): void {
  if (isTerminal(run.status)) throw new EngineError(`run ${run.id} is ${run.status}`);
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
    steps: Object.fromEntries(
      input.playbook.steps.map((step) => [
        step.id,
        { status: "pending", attempts: [], outputs: {}, summary: null, feedback: null, completedSeq: null },
      ]),
    ),
    loops: {},
    loopAllowance: {},
    gates: [],
    inbox: [],
    history: [],
    seq: 0,
  };
  log(run, input.now, "run_started", null, `playbook ${input.playbook.id}`);
  refreshReady(run);
  return run;
}

/** Pending steps whose needs are all completed become ready. Returns the newly ready ids. */
export function refreshReady(run: Run): string[] {
  if (isTerminal(run.status)) return [];
  const ready: string[] = [];
  for (const step of run.playbook.steps) {
    const state = run.steps[step.id]!;
    if (state.status !== "pending") continue;
    if (step.needs.every((need) => run.steps[need]?.status === "completed")) {
      state.status = "ready";
      ready.push(step.id);
    }
  }
  return ready;
}

export function readySteps(run: Run): string[] {
  return run.playbook.steps.filter((step) => run.steps[step.id]!.status === "ready").map((step) => step.id);
}

function updateStatus(run: Run): void {
  if (isTerminal(run.status)) return;
  run.status = run.gates.some((gate) => gate.status === "pending") ? "waiting_gate" : "running";
}

export function templateContext(run: Run): Record<string, unknown> {
  return {
    playbook: { inputs: run.inputs },
    steps: Object.fromEntries(
      Object.entries(run.steps).map(([id, state]) => [id, { outputs: state.outputs, summary: state.summary }]),
    ),
  };
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
  assertActive(run);
  const step = stepDef(run, stepId);
  const state = runStep(run, stepId);
  if (step.kind !== "agent") throw new EngineError(`step "${stepId}" is a gate; call request_gate`);
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
  };
  const context = {
    inputs: Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, entry.value])),
    run: { id: run.id },
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
  assertActive(run);
  const found = findAttemptByAgent(run, agentId);
  if (!found) throw new EngineError("this agent is not the current attempt of any step");
  const { stepId, attempt } = found;
  const step = stepDef(run, stepId);
  if (attempt.endedAt !== null && attempt.report !== null) throw new EngineError("this attempt already reported");
  if (!step.outcomes.includes(report.outcome)) {
    throw new EngineError(`outcome "${report.outcome}" is not allowed; use one of: ${step.outcomes.join(", ")}`);
  }
  let outputs: Record<string, VarValue> = {};
  if (report.outcome !== "failure") {
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

function resolveRunOutputs(run: Run): Record<string, VarValue> {
  const context = templateContext(run);
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
  run.outputs = resolveRunOutputs(run);
  finish(run, "completed", "", now, fx);
  const shown = Object.entries(run.outputs).map(([name, value]) => `${name}=${value}`).join(", ");
  if (shown) fx.notes.push(`Outputs: ${shown}.`);
  for (const next of run.playbook.next) {
    fx.notes.push(`Chain available: playbook "${next.playbook}" may follow. Decide whether to start it with start_playbook (resolve its inputs with get_run).`);
  }
}

function markCompleted(run: Run, stepId: string, now: string, fx: Effects): void {
  const state = run.steps[stepId]!;
  state.status = "completed";
  state.completedSeq = run.seq + 1;
  log(run, now, "step_completed", stepId, state.attempts.at(-1)?.outcome ?? "approved");
  if (run.playbook.steps.every((step) => run.steps[step.id]!.status === "completed")) {
    completeRun(run, now, fx);
    return;
  }
  const ready = refreshReady(run);
  if (ready.length > 0) fx.notes.push(`Ready: ${ready.join(", ")}.`);
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
  const ready = refreshReady(run);
  fx.notes.push(`Looping back to "${target}" (loop ${run.loops[key]}). Ready: ${ready.join(", ") || "none"}.`);
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
    status: "pending",
    message: `Loop limit reached: "${step.id}" → "${target}" ran ${run.loops[key] ?? 0} times (max ${maxLoops}). Approve one more loop, or reject to fail the run.\n\nLatest feedback: ${feedback || "(none)"}`,
    summary: `Loop limit reached: "${step.id}" → "${target}" ran ${run.loops[key] ?? 0} times (max ${maxLoops}). Approve one more loop, or reject to fail the run.`,
    details: `Latest feedback: ${feedback || "(none)"}`,
    requestedAt: now,
    comment: feedback || null,
    decidedBy: null,
    decidedVia: null,
    decidedAt: null,
  };
  run.gates.push(gate);
  log(run, now, "gate_opened", step.id, gate.id);
  fx.notes.push(`Loop limit reached for ${key}: a human gate (${gate.id}) is open. Tell the human; wait for the decision.`);
}

/** The manager's verdict on a reported (or running) agent step. */
export function completeStep(
  run: Run,
  stepId: string,
  input: { outcome: string; summary?: string; outputs?: Record<string, unknown>; now: string },
): Effects {
  assertActive(run);
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
      state.status = "completed";
      completeRun(run, input.now, fx);
      break;
    case "fail":
      state.status = "failed";
      finish(run, "failed", `step "${stepId}" ended with "${input.outcome}"`, input.now, fx);
      break;
    case "retry": {
      const counted = state.attempts.filter((a) => a.turnEnd !== "lost").length;
      if (counted <= step.retries) {
        state.status = "ready";
        state.feedback = summary ? `Previous attempt failed: ${summary}` : null;
        fx.notes.push(`"${stepId}" failed; retry ${counted}/${step.retries} allowed. Ready: ${readySteps(run).join(", ")}.`);
      } else {
        state.status = "failed";
        finish(run, "failed", `step "${stepId}" failed after ${counted} attempt(s)`, input.now, fx);
      }
      break;
    }
    case "goto":
      gotoOrLimit(run, step, transition.target, transition.maxLoops, summary, input.now, fx);
      break;
  }
  updateStatus(run);
  return fx;
}

/** Opens the human gate of a ready gate step. */
export function requestGate(run: Run, stepId: string, summary: string, now: string, details = ""): Gate {
  assertActive(run);
  const step = stepDef(run, stepId);
  const state = runStep(run, stepId);
  if (step.kind !== "gate") throw new EngineError(`step "${stepId}" is not a gate`);
  if (state.status !== "ready") throw new EngineError(`gate "${stepId}" is ${state.status}, not ready`);
  const gate: Gate = {
    id: `${stepId}-${state.attempts.length + run.gates.filter((g) => g.stepId === stepId).length + 1}`,
    kind: "gate",
    stepId,
    gotoTarget: null,
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
  assertActive(run);
  const choices = gate.kind === "loop_limit" ? LOOP_LIMIT_CHOICES : gateChoices(stepDef(run, gate.stepId));
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
  if (gate.kind === "loop_limit") {
    if (decision.decision === "approved") {
      const key = `${gate.stepId}->${gate.gotoTarget}`;
      run.loopAllowance[key] = (run.loopAllowance[key] ?? 0) + 1;
      performGoto(run, gate.stepId, gate.gotoTarget!, run.steps[gate.stepId]!.summary ?? decision.comment ?? "", decision.now, fx);
    } else {
      run.steps[gate.stepId]!.status = "failed";
      finish(run, "failed", `loop limit for "${gate.stepId}" → "${gate.gotoTarget}" rejected`, decision.now, fx);
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
      state.status = "completed";
      completeRun(run, decision.now, fx);
      break;
    case "goto":
      gotoOrLimit(run, step, transition.target, transition.maxLoops, decision.comment ?? "", decision.now, fx);
      break;
    default:
      state.status = "failed";
      finish(run, "failed", `gate "${gate.stepId}" ${decision.decision}${decision.comment ? `: ${decision.comment}` : ""}`, decision.now, fx);
  }
  updateStatus(run);
  return { gate, alreadyDecided: false, effects: fx };
}

/** Cancels the run and returns the agents to interrupt. */
export function cancelRun(run: Run, reason: string, now: string): Effects {
  assertActive(run);
  const fx = effects();
  finish(run, "canceled", reason, now, fx);
  return fx;
}

/** Fails the run (e.g. the manager was lost). */
export function failRun(run: Run, reason: string, now: string): Effects {
  const fx = effects();
  if (isTerminal(run.status)) return fx;
  finish(run, "failed", reason, now, fx);
  return fx;
}

/** Marks a failed or timed-out readonly check on the current attempt. */
export function markReadonlyViolation(run: Run, stepId: string, detail: string, now: string): void {
  const attempt = currentAttempt(run, stepId);
  if (!attempt) return;
  attempt.report = { outcome: "failure", summary: `readonly role modified the checkout: ${detail}`, outputs: {} };
  log(run, now, "readonly_violation", stepId, detail);
}
