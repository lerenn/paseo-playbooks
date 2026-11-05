import { defineAgentTool, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { askHumanText, choicesOfGate, GATE_SUMMARY_MAX } from "../shared/gates";
import { z } from "zod";
import type { PlaybookEntry, Run } from "../shared/types";
import { isActive, isPaused, isScriptAttempt, isTerminal, restartBlocker, runningAfterTasks, VarValueSchema } from "../shared/types";
import * as engine from "./engine";
import { hasPlaybooks, loadPlaybooks } from "./loader";
import { MANAGER_PROTOCOL } from "./prompts";
import { UserError, type Runtime } from "./runtime";

function ok(text: string, structuredContent?: unknown): AgentToolResult {
  return structuredContent === undefined ? { text } : { text, structuredContent };
}

/** Turns refusals into tool errors the model can act on; unexpected errors are logged. */
async function guard(fn: () => Promise<AgentToolResult>): Promise<AgentToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof UserError) && !(error instanceof engine.EngineError)) console.error("[playbooks] tool failed:", error);
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

/** Characters of a step summary the compact view keeps. */
export const COMPACT_SUMMARY_MAX = 300;

function clip(text: string | null, max = COMPACT_SUMMARY_MAX): string | null {
  return text !== null && text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The step ids a view covers: all of them, or the requested ones (refused if unknown). */
function viewSteps(run: Run, only?: string[]): string[] {
  const all = run.playbook.steps.map((step) => step.id);
  if (!only || only.length === 0) return all;
  const unknown = only.filter((id) => !all.includes(id));
  if (unknown.length) throw new UserError(`unknown step(s) ${unknown.join(", ")} in run ${run.id} (steps: ${all.join(", ")})`);
  return all.filter((id) => only.includes(id));
}

function runningSteps(run: Run): string[] {
  return Object.entries(run.steps)
    .filter(([, state]) => state.status === "running")
    .map(([id]) => id);
}

/** A gate without its details, its comment clipped like a step summary. */
function compactGate(gate: Run["gates"][number]) {
  return { id: gate.id, kind: gate.kind, stepId: gate.stepId, status: gate.status, summary: gate.summary, comment: clip(gate.comment), decidedBy: gate.decidedBy };
}

function afterStatus(run: Run) {
  return run.playbook.after.map((task) => ({ id: task.id, trigger: task.trigger, status: run.after[task.id]?.status ?? "pending", detail: run.after[task.id]?.detail ?? null }));
}

/** What a mutating manager tool changed: the step it acted on and what comes next. get_run shows the rest. */
export function runChange(run: Run, stepId?: string) {
  const state = stepId ? run.steps[stepId] : undefined;
  return {
    runId: run.id,
    status: run.status,
    failure: run.failure,
    active: isActive(run),
    paused: isPaused(run),
    ...(state ? { step: { id: stepId, status: state.status, outcome: state.attempts.at(-1)?.outcome ?? null, attempts: state.attempts.length } } : {}),
    ready: engine.readySteps(run),
    queued: engine.queuedSteps(run),
    running: runningSteps(run),
    gates: run.gates.filter((gate) => gate.status === "pending").map(compactGate),
    ...(isTerminal(run.status) ? { outputs: run.outputs } : {}),
    after: afterStatus(run),
  };
}

/** The default get_run view: one short line of state per step, no reports, outputs or inputs. */
export function runCompact(run: Run, only?: string[]) {
  return {
    runId: run.id,
    playbook: run.playbook.id,
    status: run.status,
    failure: run.failure,
    active: isActive(run),
    paused: isPaused(run),
    branch: run.branch,
    outputs: run.outputs,
    ready: engine.readySteps(run),
    queued: engine.queuedSteps(run),
    running: runningSteps(run),
    steps: Object.fromEntries(
      viewSteps(run, only).map((id) => {
        const step = engine.stepDef(run, id);
        const state = run.steps[id]!;
        const attempt = state.attempts.at(-1);
        return [
          id,
          {
            kind: step.kind,
            ...(step.afterTask ? { afterTask: step.afterTask } : {}),
            status: state.status,
            outcome: attempt?.outcome ?? attempt?.report?.outcome ?? null,
            attempts: state.attempts.length,
            turnEnd: attempt?.turnEnd ?? null,
            summary: clip(state.summary ?? attempt?.report?.summary ?? null),
          },
        ];
      }),
    ),
    gates: run.gates.map(compactGate),
    loops: run.loops,
    after: afterStatus(run),
  };
}

/** The full get_run view: every step's definition, latest report, outputs and summary, with the gates in full. */
export function runFull(run: Run, only?: string[]) {
  return {
    runId: run.id,
    playbook: run.playbook.id,
    status: run.status,
    failure: run.failure,
    /** True while the main graph or an after-task still runs. */
    active: isActive(run),
    /** True while a human has paused the run: start_step is refused until they resume it. */
    paused: isPaused(run),
    branch: run.branch,
    inputs: run.inputs,
    outputs: run.outputs,
    ready: engine.readySteps(run),
    queued: engine.queuedSteps(run),
    steps: Object.fromEntries(
      viewSteps(run, only).map((id) => {
        const step = engine.stepDef(run, id);
        const state = run.steps[id]!;
        const attempt = state.attempts.at(-1);
        return [
          step.id,
          {
            kind: step.kind,
            role: step.role ?? null,
            afterTask: step.afterTask ?? null,
            needs: step.needs,
            outcomes: step.outcomes,
            status: state.status,
            attempts: state.attempts.length,
            agentId: attempt && !isScriptAttempt(attempt.agentId) ? attempt.agentId : null,
            ...(step.kind === "script" ? { script: step.script, checks: attempt?.checks ?? 0, nextCheckAt: attempt?.nextCheckAt ?? null } : {}),
            report: attempt?.report ?? null,
            lastMessage: attempt?.report ? null : attempt?.lastMessage ?? null,
            turnEnd: attempt?.turnEnd ?? null,
            outputs: state.outputs,
            summary: state.summary,
          },
        ];
      }),
    ),
    gates: run.gates,
    loops: run.loops,
    after: run.playbook.after.map((task) => ({ ...task, ...(run.after[task.id] ?? { status: "pending" }) })),
  };
}

/** What a finished run still does: its running after-tasks and their ready steps. Empty while the main graph runs. */
export function afterText(run: Run): string {
  if (!isTerminal(run.status)) return "";
  const running = runningAfterTasks(run);
  if (running.length === 0) return "";
  const ready = engine.readySteps(run);
  const gates = ready.filter((id) => engine.stepDef(run, id).kind === "gate");
  const waiting = run.gates.some((gate) => gate.status === "pending");
  return ` After-tasks running: ${running.join(", ")} (their result does not change the run, which stays ${run.status}). ${
    waiting ? "A gate is waiting for a human decision. " : ""
  }Ready: ${ready.join(", ") || "none"}.${gates.length ? ` Gate(s) to open with request_gate: ${gates.join(", ")}.` : ""}`;
}

function describeEntry(entry: PlaybookEntry) {
  if (!entry.playbook) return { id: entry.id, file: entry.file, valid: false, errors: entry.errors };
  const pb = entry.playbook;
  return {
    id: pb.id,
    file: pb.file,
    valid: true,
    title: pb.title,
    description: pb.description,
    hidden: entry.hidden,
    inputs: pb.inputs,
    outputs: Object.fromEntries(Object.entries(pb.outputs).map(([name, def]) => [name, { type: def.type, from: def.label }])),
    concurrency: pb.concurrency ?? null,
    after: pb.after.map((task) => ({ id: task.id, title: task.title, trigger: task.trigger, steps: task.steps })),
    steps: pb.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      role: step.role ? `${step.role} (${pb.roles[step.role]!.title}${pb.roles[step.role]!.readonly ? ", readonly" : ""})` : null,
      gate: step.gate ?? null,
      ...(step.kind === "script" ? { script: step.script, poll: step.pollMs ? `${step.pollMs / 1000}s` : null } : {}),
      afterTask: step.afterTask ?? null,
      needs: step.needs,
      inputs: Object.fromEntries(Object.entries(step.inputs).map(([name, wiring]) => [name, `${wiring.label}${wiring.auto ? " (auto)" : ""}`])),
      outputs: Object.fromEntries(Object.entries(step.outputs).map(([name, def]) => [name, def.type])),
      outcomes: step.outcomes,
      on: step.on,
      retries: step.retries,
      agent: step.agent,
    })),
  };
}

const IdArg = z.string().describe("Run id returned by start_playbook");

export function managerTools(runtime: Runtime): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "list_playbooks",
      description: "List the playbooks of this workspace (inputs, steps, roles, validation errors) and explain how a Playbook Manager runs them.",
      input: z.object({}),
      execute: (_input, { agent }) =>
        guard(async () => {
          const loaded = await loadPlaybooks(agent.cwd);
          const playbooks = loaded.entries.map(describeEntry);
          return ok(`${MANAGER_PROTOCOL}\n\nPlaybooks:\n${JSON.stringify(playbooks, null, 2)}`, { playbooks });
        }),
    }),
    defineAgentTool({
      name: "start_playbook",
      description: "Create a run of a playbook with you as its manager, in your workspace (one active run per workspace). Returns the run id and the ready steps.",
      input: z.object({
        playbook: z.string().describe("Playbook id (its file name without .yaml)"),
        inputs: z.record(z.string(), VarValueSchema).default({}).describe("Playbook inputs by name"),
      }),
      execute: ({ playbook, inputs }, { agent }) =>
        guard(async () => {
          const run = await runtime.startPlaybook(agent, playbook, inputs);
          return ok(
            `Run ${run.id} started on branch ${run.branch ?? "(unknown)"}. Ready: ${engine.readySteps(run).join(", ") || "none"}. Start them with start_step.${engine.queuedSteps(run).length ? ` Queued for a free concurrency slot of another run: ${engine.queuedSteps(run).join(", ")}; you are woken when they are ready.` : ""}`,
            runChange(run),
          );
        }),
    }),
    defineAgentTool({
      name: "start_step",
      description: "Start a ready agent step as a subagent. The plugin renders the step prompt and inputs; your brief adds context they lack.",
      input: z.object({ runId: IdArg, stepId: z.string(), brief: z.string().default("").describe("Short brief for the step agent") }),
      execute: ({ runId, stepId, brief }, { agent }) =>
        guard(async () => {
          const started = await runtime.startStep(agent.id, runId, stepId, brief);
          return ok(
            `Step "${stepId}" attempt ${started.attempt} started (agent ${started.agentId}). End your turn; you will be woken when it finishes.`,
            started,
          );
        }),
    }),
    defineAgentTool({
      name: "complete_step",
      description: "Decide the outcome of a reported step. The plugin applies the playbook's transition and returns what is ready next, a gate, or the end of the run.",
      input: z.object({
        runId: IdArg,
        stepId: z.string(),
        outcome: z.string().describe("One of the step's outcomes"),
        summary: z.string().optional().describe("Overrides the step's summary (also used as loop feedback)"),
        outputs: z.record(z.string(), VarValueSchema).optional().describe("Corrections to reported outputs"),
      }),
      execute: ({ runId, stepId, ...rest }, { agent }) =>
        guard(async () => {
          const input: { outcome: string; summary?: string; outputs?: Record<string, unknown> } = { outcome: rest.outcome };
          if (rest.summary !== undefined) input.summary = rest.summary;
          if (rest.outputs !== undefined) input.outputs = rest.outputs;
          const run = await runtime.completeStep(agent.id, runId, stepId, input);
          await runtime.clearInbox(run.id);
          const ready = engine.readySteps(run);
          const queued = engine.queuedSteps(run);
          const gates = ready.filter((id) => engine.stepDef(run, id).kind === "gate");
          const text =
            run.status === "completed"
              ? `Run ${run.id} completed. Outputs: ${JSON.stringify(run.outputs)}.${afterText(run)}`
              : run.status === "failed"
                ? `Run ${run.id} failed: ${run.failure}.${afterText(run)}`
                : run.status === "canceled"
                  ? `Run ${run.id} canceled.${afterText(run)}`
                  : run.status === "waiting_gate"
                  ? `A gate is waiting for a human decision. End your turn.`
                  : `Ready: ${ready.join(", ") || (queued.length ? "none" : "none (waiting for running steps)")}.${queued.length ? ` Queued for a free concurrency slot of another run: ${queued.join(", ")}; end your turn, you are woken when they are ready.` : ""}${gates.length ? ` Gate(s) to open with request_gate: ${gates.join(", ")}.` : ""}`;
          const paused = isPaused(run) ? " The run is paused by a human: do not start steps; end your turn, you are woken on resume." : "";
          return ok(text + paused, runChange(run, stepId));
        }),
    }),
    defineAgentTool({
      name: "request_gate",
      description:
        "Open a ready gate step for a human: a one-sentence summary shown on the gate, and details (what was done, links, risks) shown collapsed under it. Then ask the human in chat (the result says how).",
      input: z.object({
        runId: IdArg,
        stepId: z.string(),
        summary: z
          .string()
          .max(GATE_SUMMARY_MAX, `One short sentence (at most ${GATE_SUMMARY_MAX} characters); put everything else in details`)
          .describe(`One short sentence (at most ${GATE_SUMMARY_MAX} characters): what the human decides, e.g. "PR #3 is green and ready to merge."`),
        details: z.string().default("").describe("What was done, links, risks, follow-ups (collapsed under the summary)"),
      }),
      execute: ({ runId, stepId, summary, details }, { agent }) =>
        guard(async () => {
          const gate = await runtime.requestGate(agent.id, runId, stepId, summary, details);
          const step = runtime.ownedRun(agent.id, runId).playbook.steps.find((candidate) => candidate.id === gate.stepId);
          return ok(`Gate ${gate.id} is open in the Paseo panel. ${askHumanText(gate, choicesOfGate(gate, step))}`, gate);
        }),
    }),
    defineAgentTool({
      name: "resume",
      description: "Record a gate decision that reached you by chat (e.g. a Slack reply). If the panel already decided, returns that decision.",
      input: z.object({
        runId: IdArg,
        stepId: z.string().describe("Gate step id or gate id"),
        decision: z.string().describe('One of the gate\'s choices (by default "approved" or "rejected"; an ask gate\'s are "answered" or its declared choices)'),
        comment: z.string().optional(),
        decidedBy: z.string().optional().describe("Who decided, e.g. a Slack user id"),
      }),
      execute: ({ runId, stepId, decision, comment, decidedBy }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          const result = await runtime.decideGate(runId, stepId, {
            decision,
            comment: comment ?? null,
            by: decidedBy ?? null,
            via: "chat",
            now: new Date().toISOString(),
          });
          const run = (await runtime.ownedRun(agent.id, runId))!;
          const prefix = result.alreadyDecided ? `Already decided: ${result.gate.status} via ${result.gate.decidedVia}.` : `Recorded ${decision}.`;
          return ok(`${prefix} Run is ${run.status}.${afterText(run)} Ready: ${engine.readySteps(run).join(", ") || "none"}.${engine.queuedSteps(run).length ? ` Queued for a free concurrency slot: ${engine.queuedSteps(run).join(", ")}.` : ""}`, runChange(run, result.gate.stepId));
        }),
    }),
    defineAgentTool({
      name: "nudge_step",
      description: "Send a follow-up message to a step's current agent (same conversation, no new attempt), e.g. when it ended without reporting. On a step that timed out, its next report replaces the timeout failure.",
      input: z.object({ runId: IdArg, stepId: z.string(), message: z.string() }),
      execute: ({ runId, stepId, message }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          await runtime.nudgeStep(runId, stepId, message);
          return ok(`Sent to "${stepId}". End your turn; you will be woken when it finishes.`);
        }),
    }),
    defineAgentTool({
      name: "get_run",
      description:
        'Show a run\'s state. Without runId, your active (or latest) run. view "compact" (default): per step its status, outcome, attempts, turn end and the start of its summary, plus gates, loops and after-tasks. view "full": every step\'s definition, full report, outputs and summary, the run inputs and the gates in full (e.g. for a retro brief). steps limits either view to those steps.',
      input: z.object({
        runId: IdArg.optional(),
        view: z.enum(["compact", "full"]).default("compact").describe('"compact" (default) or "full" (reports, outputs, inputs, gate details)'),
        steps: z.array(z.string()).optional().describe("Only these step ids (default: all)"),
      }),
      execute: ({ runId, view, steps }, { agent }) =>
        guard(async () => {
          const run = runtime.ownedRun(agent.id, runId);
          await runtime.clearInbox(run.id);
          const summary = view === "full" ? runFull(run, steps) : runCompact(run, steps);
          return ok(JSON.stringify(summary, null, 2), summary);
        }),
    }),
  ];
}

/** One line per run for agents that do not manage it. */
export function runListing(run: Run) {
  return {
    runId: run.id,
    playbook: run.playbook.id,
    title: run.playbook.title,
    status: run.status,
    /** Why a failed run failed, e.g. "manager lost (archived)". */
    failure: run.failure,
    active: isActive(run),
    paused: isPaused(run),
    workspaceId: run.workspaceId,
    workspaceDir: run.workspaceDir,
    branch: run.branch,
    managerAgentId: run.managerAgentId,
    createdAt: run.createdAt,
    runningSteps: Object.entries(run.steps).filter(([, state]) => state.status === "running").map(([id]) => id),
    archived: run.archivedAt !== null,
    /** After-tasks and their status; start_after_task starts a pending manual one. */
    after: run.playbook.after.map((task) => ({ id: task.id, title: task.title, trigger: task.trigger, status: run.after[task.id]?.status ?? "pending" })),
    /** Steps restart_run accepts (empty while the run is active). */
    restartableFrom: isTerminal(run.status) ? run.playbook.steps.filter((step) => restartBlocker(run, step.id) === null).map((step) => step.id) : [],
  };
}

/** The run cancel_run targets without a runId: the caller's own active run, else the only active run of its workspace. */
export function defaultRunToCancel(runs: Run[], agentId: string, workspaceId: string | null): Run {
  const active = runs.filter((run) => isActive(run));
  const own = active.find((run) => run.managerAgentId === agentId);
  if (own) return own;
  const here = active.filter((run) => workspaceId !== null && run.workspaceId === workspaceId);
  if (here.length === 1) return here[0]!;
  if (here.length > 1) throw new UserError(`several runs are active in your workspace (${here.map((run) => run.id).join(", ")}): pass runId`);
  throw new UserError(
    active.length === 0
      ? "no run is active"
      : `no run is active in your workspace: pass runId (active runs: ${active.map((run) => `${run.id} (${run.playbook.id}, ${run.branch ?? run.workspaceDir})`).join(", ")})`,
  );
}

/** Tools for every agent except step agents: find runs, cancel and restart them, e.g. when the human asks in any chat. */
export function runTools(runtime: Runtime): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "list_runs",
      description:
        "List playbook runs on this Paseo daemon (by default only active ones): id, playbook, status, workspace, branch, manager, running steps, and where a finished run can be restarted from.",
      input: z.object({
        all: z.boolean().default(false).describe("Include finished runs that are not archived"),
        archived: z.boolean().default(false).describe("Also include archived runs (archiving a manager archives its runs)"),
      }),
      execute: ({ all, archived }) =>
        guard(async () => {
          const runs = runtime
            .allRuns()
            .filter((run) => (archived || !run.archivedAt) && (all || archived || isActive(run)))
            .map(runListing);
          return ok(runs.length === 0 ? (all || archived ? "No runs." : "No active run.") : JSON.stringify(runs, null, 2), { runs });
        }),
    }),
    defineAgentTool({
      name: "cancel_run",
      description:
        "Cancel a playbook run and stop its running step agents; its manager is told. On a run that has ended, cancels its running after-tasks (its status stays). Without runId: the run you manage, else the active run of your workspace (see list_runs).",
      input: z.object({ runId: IdArg.optional(), reason: z.string().describe("Why, shown on the run") }),
      execute: ({ runId, reason }, { agent }) =>
        guard(async () => {
          const target = runId ? runtime.allRuns().find((run) => run.id === runId) : defaultRunToCancel(runtime.allRuns(), agent.id, agent.workspaceId);
          if (!target) throw new UserError(`unknown run "${runId}"`);
          const isManager = target.managerAgentId === agent.id;
          const run = await runtime.cancelRun(target.id, reason, isManager ? null : `by agent ${agent.id}`);
          return ok(
            isTerminal(run.status) && run.status !== "canceled" ? `After-tasks of run ${run.id} canceled; the run stays ${run.status}.` : `Run ${run.id} canceled.`,
            isManager ? runChange(run) : runListing(run),
          );
        }),
    }),
    defineAgentTool({
      name: "start_after_task",
      description:
        "Start a manual after-task (trigger: manual, e.g. a retro) of a finished run, the same as its Start button in the panel. Call it only when the human asks for it. It runs once. The run's manager is woken to run it; if you are that manager, start its ready steps with start_step. See get_run or list_runs for the run's after-tasks.",
      input: z.object({
        runId: IdArg,
        taskId: z.string().describe("After-task id (see `after` in get_run or list_runs)"),
      }),
      execute: ({ runId, taskId }, { agent }) =>
        guard(async () => {
          const run = await runtime.startAfterTask(runId, taskId, agent.id);
          if (run.managerAgentId === agent.id) {
            return ok(
              `After-task "${taskId}" of run ${run.id} started. Start its ready steps (${engine.readySteps(run).join(", ") || "none"}) with start_step (or request_gate for a gate). For a retro brief, get_run with view "full" gives the whole run.`,
              runChange(run),
            );
          }
          return ok(`After-task "${taskId}" of run ${run.id} started. Its manager (agent ${run.managerAgentId}) was woken and runs it.`, runListing(run));
        }),
    }),
    defineAgentTool({
      name: "restart_run",
      description:
        "Recover a finished (completed, failed, canceled, or failed with \"manager lost\") or archived run: reopen it from a step of its main graph whose needs completed. That step and everything after it run again; completed steps before it keep their outputs and are not repeated. With takeOver: true you become its manager (you must be in the run's workspace). Otherwise its manager is woken, or, if that manager was archived, a new Playbook Manager is created in the run's workspace and takes over. See list_runs (archived: true) for runs, failure and restartableFrom.",
      input: z.object({
        runId: IdArg,
        stepId: z.string().describe("Step to restart from (see restartableFrom in list_runs)"),
        note: z.string().optional().describe("Feedback for the restarted step's next attempt, e.g. what changed since it stopped"),
        takeOver: z
          .boolean()
          .default(false)
          .describe("Become the run's manager yourself (you must be an agent of the run's workspace), instead of its previous manager or a new one"),
      }),
      execute: ({ runId, stepId, note, takeOver }, { agent }) =>
        guard(async () => {
          // A taker needs the manager tools, which agents get in a workspace with playbooks.
          if (takeOver && runtime.runsOfManager(agent.id).length === 0 && !(await hasPlaybooks(agent.cwd))) {
            throw new UserError("you do not have the manager tools (your workspace has no playbooks): omit takeOver and a Playbook Manager is found for the run");
          }
          const { run, newManager } = await runtime.restartRun(runId, stepId, note?.trim() || null, agent.id, "agent", takeOver ? { id: agent.id, workspaceId: agent.workspaceId } : undefined);
          const isManager = run.managerAgentId === agent.id;
          const next = isManager
            ? `You manage it${newManager ? " now (get_run with view \"full\" shows the completed steps' reports and outputs)" : ""}: start the ready steps (${engine.readySteps(run).join(", ") || "none"}) with start_step.`
            : newManager
              ? `Its previous manager was archived: a new Playbook Manager (agent ${run.managerAgentId}) took it over and starts the ready steps.`
              : `Its manager (agent ${run.managerAgentId}) was woken and starts the ready steps.`;
          return ok(`Run ${run.id} restarted from "${stepId}". ${next}`, isManager ? runChange(run, stepId) : runListing(run));
        }),
    }),
  ];
}

export function validateTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "validate_playbooks",
    description:
      "Validate the playbooks in <workspace>/.paseo/plugins/playbooks/ and <workspace>/.paseo/playbooks/ (or in the given workspace folder) with the same checks as the Playbooks panel. Writes nothing.",
    input: z.object({ path: z.string().optional().describe("Workspace folder to check; defaults to yours") }),
    execute: ({ path }, { agent }) =>
      guard(async () => {
        const loaded = await loadPlaybooks(path ?? agent.cwd);
        if (!loaded.exists) return ok(`No playbooks folder: create .paseo/plugins/playbooks/ or .paseo/playbooks/ in ${path ?? agent.cwd}.`, { exists: false });
        const results = loaded.entries.map(describeEntry);
        const invalid = results.filter((result) => !result.valid).length;
        const head = loaded.entries.length === 0 ? "No playbook files found." : invalid === 0 ? `All ${results.length} playbook(s) are valid.` : `${invalid} of ${results.length} playbook(s) have errors.`;
        return ok(`${head}\n${JSON.stringify(results, null, 2)}`, { exists: true, results });
      }),
  });
}

export function stepTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "report_step_result",
    description: "Report this playbook step's result. Call exactly once, as your last action. Refused (with the reason) if outputs are missing or mistyped.",
    input: z.object({
      outcome: z.string().describe("One of the outcomes listed in your instructions"),
      summary: z.string().describe("What you did and found"),
      outputs: z.record(z.string(), VarValueSchema).default({}).describe("Declared outputs by name"),
    }),
    execute: (report, { agent }) =>
      guard(async () => {
        const stepId = await runtime.report(agent.id, report);
        return ok(`Report for "${stepId}" recorded. Stop here: end your turn.`);
      }),
  });
}
