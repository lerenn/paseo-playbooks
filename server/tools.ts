import { SlowIndex, slowEntries, slowEntry } from "./slow";
import type { SlowInfo } from "../shared/slow";
import { checkSubscriptionScope } from "./bus";
import { defineAgentTool, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { askHumanText, choicesOfGate, GATE_SUMMARY_MAX, waitsForHuman } from "../shared/gates";
import { z } from "zod";
import type { PlaybookEntry, Run, When } from "../shared/types";
import { repairReport } from "./malformed";
import { isActive, isAgentlessAttempt, isPaused, isPipeline, isTerminal, restartBlocker, runningAfterTasks, VarValueSchema } from "../shared/types";
import * as engine from "./engine";
import { resolveForNewRun } from "./fresh";
import { hasPlaybooks, loadPlaybooks } from "./loader";
import { conversationText } from "./conversation";
import { attentionText } from "./overseer";
import { MANAGER_PROTOCOL, managerInstructionsText, worktreePreamble } from "./prompts";
import { UserError, type ModelChoice, type Runtime } from "./runtime";

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
  return { id: gate.id, kind: gate.kind, ...(gate.jobId ? { jobId: gate.jobId } : {}), stepId: gate.stepId, status: gate.status, waitingForHuman: waitsForHuman(gate), summary: gate.summary, comment: clip(gate.comment), decidedBy: gate.decidedBy };
}

/** A batch's (or pipeline's) jobs: id, where from, status and outcome (inputs with view "full"). */
function jobStatus(run: Run, full = false) {
  return run.jobs.map((job) => ({
    id: job.id,
    from: job.label,
    status: job.status,
    outcome: job.outcome,
    // A detached job ended by a batch: whether anyone started what follows (record_followup, start_playbook forJob). pending: true = nobody did yet.
    ...(job.detached ? { detached: true, followUps: job.followUps.map((entry) => ({ runId: entry.runId, note: entry.note, at: entry.at })), ...(isPipeline(run) && job.status === "settled" && job.outcome !== null && job.outcome !== run.playbook.outcomes[0] ? { followUpPending: job.followUps.length === 0 } : {}) } : {}),
    ...(isPipeline(run)
      ? {
          passed: job.passed,
          waiting: job.waiting.map((place) => place.stage),
          batches: job.batches.map((ride) => `${ride.stage} (${ride.runId})`),
          // Deprecated name of `batches`, until the end of the stage/batch aliases (ADR 2026-11-12-stage-batch-rename).
          riding: job.batches.map((ride) => `${ride.stage} (${ride.runId})`),
          // Held by a stage's admission script: why, since when it waits, and when that was decided (null: not checked yet).
          ...(job.waiting.some((place) => place.held) ? { held: Object.fromEntries(job.waiting.flatMap((place) => (place.held ? [[place.stage, { reason: place.held.reason, since: place.since, checkedAt: place.held.checkedAt }]] : []))) } : {}),
        }
      : {}),
    ...(full ? { inputs: job.inputs, outputs: job.outputs, summary: job.summary } : { summary: clip(job.summary) }),
  }));
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
    ...(run.jobs.length > 0 || run.batch ? { jobs: jobStatus(run) } : {}),
    after: afterStatus(run),
  };
}

/** An isolated run's worktree (`isolation: worktree`); nothing for a run in the workspace checkout. */
function worktreeView(run: Run) {
  return {
    ...(run.worktree ? { worktree: { path: run.worktree.path, branch: run.worktree.branch, state: run.worktree.state } } : {}),
    ...(run.definition ? { definition: run.definition } : {}),
  };
}

/** When the manager passes `model`, in the tool descriptions. */
const MODEL_USE =
  "model (optional): a provider/model (see list_providers and list_models) for this attempt only, instead of the role's model and its fallbacks; thinking: one of that model's thinking options. The step's mode and thinking carry over only on the same provider. Pass it only when the role's model cannot run (out of tokens, unavailable) or the human asks for another model; the plugin already fails over on its own when the role has fallbacks.";

const ModelArgs = {
  model: z.string().optional().describe("provider/model for this attempt only, e.g. claude/claude-opus-5-5 (list_models)"),
  thinking: z.string().optional().describe("Thinking option of that model (with model only)"),
};

function modelChoice(model: string | undefined, thinking: string | undefined): ModelChoice | undefined {
  if (!model?.trim()) {
    if (thinking) throw new UserError("thinking only applies with model");
    return undefined;
  }
  return { target: model.trim(), ...(thinking ? { thinking } : {}) };
}

/** Per attempt, the models its agents ran on, oldest first (an attempt from before this history shows its last one). */
function attemptModels(attempts: Run["steps"][string]["attempts"]) {
  return attempts.map((attempt) => ({
    attempt: attempt.n,
    agents: attempt.agents.length > 0 ? attempt.agents : attempt.target ? [{ agentId: attempt.agentId, target: attempt.target, at: attempt.startedAt, why: "chain" as const }] : [],
  }));
}

/** The default get_run view: one short line of state per step, no reports, outputs or inputs. */
export function runCompact(run: Run, only?: string[], slow: Record<string, SlowInfo> = {}) {
  return {
    runId: run.id,
    playbook: run.playbook.id,
    status: run.status,
    failure: run.failure,
    managerMode: run.playbook.managerMode,
    active: isActive(run),
    paused: isPaused(run),
    branch: run.branch,
    ...worktreeView(run),
    outputs: run.outputs,
    ready: engine.readySteps(run),
    queued: engine.queuedSteps(run),
    running: runningSteps(run),
    slowSteps: Object.keys(slow),
    steps: Object.fromEntries(
      viewSteps(run, only).map((id) => {
        const step = engine.stepDef(run, id);
        const state = run.steps[id]!;
        const attempt = state.attempts.at(-1);
        return [
          id,
          {
            kind: step.kind,
            ...(step.description ? { description: step.description } : {}),
            ...(step.afterTask ? { afterTask: step.afterTask } : {}),
            status: state.status,
            outcome: attempt?.outcome ?? attempt?.report?.outcome ?? null,
            attempts: state.attempts.length,
            ...(attempt?.target ? { model: attempt.target } : {}),
            turnEnd: attempt?.turnEnd ?? null,
            ...(slow[id] ? { slow: slowEntry(run, id, slow[id]!) } : {}),
            summary: clip(state.summary ?? attempt?.report?.summary ?? null),
          },
        ];
      }),
    ),
    gates: run.gates.map(compactGate),
    loops: run.loops,
    ...(run.jobs.length > 0 || run.batch ? { jobs: jobStatus(run) } : {}),
    after: afterStatus(run),
  };
}

/** The full get_run view: every step's definition, latest report, outputs and summary, with the gates in full. */
export function runFull(run: Run, only?: string[], slow: Record<string, SlowInfo> = {}) {
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
    ...worktreeView(run),
    inputs: run.inputs,
    outputs: run.outputs,
    ready: engine.readySteps(run),
    queued: engine.queuedSteps(run),
    slowSteps: Object.keys(slow),
    steps: Object.fromEntries(
      viewSteps(run, only).map((id) => {
        const step = engine.stepDef(run, id);
        const state = run.steps[id]!;
        const attempt = state.attempts.at(-1);
        return [
          step.id,
          {
            kind: step.kind,
            ...(step.description ? { description: step.description } : {}),
            role: step.role ?? null,
            afterTask: step.afterTask ?? null,
            needs: step.needs,
            outcomes: step.outcomes,
            status: state.status,
            attempts: state.attempts.length,
            agentId: attempt && !isAgentlessAttempt(attempt.agentId) ? attempt.agentId : null,
            ...(step.kind === "agent" ? { models: attemptModels(state.attempts), ...(state.nextModel ? { nextModel: state.nextModel } : {}) } : {}),
            ...(step.autoComplete?.length ? { autoComplete: step.autoComplete } : {}),
      ...(step.kind === "handoff" ? { handoff: step.handoff, job: attempt?.job ?? null } : {}),
            ...(step.kind === "script" ? { script: step.script, checks: attempt?.checks ?? 0, nextCheckAt: attempt?.nextCheckAt ?? null } : {}),
            ...(step.kind === "branch" ? { chosen: state.branch } : {}),
            ...(step.kind === "fanout" && state.fanout && state.status !== "pending" && state.status !== "ready"
              ? { fanout: { playbook: step.fanout!.playbook, loop: state.fanout.loop, ...engine.fanoutCounts(state.fanout), ...(state.fanout.pool ? { pool: { refills: state.fanout.pool.refills, lastRefillAt: state.fanout.pool.lastRefillAt, added: state.fanout.pool.added, status: state.fanout.pool.status, ...(state.fanout.pool.stopReason ? { stopReason: state.fanout.pool.stopReason } : {}), passes: state.fanout.pool.passes.map((pass) => ({ n: pass.n, status: pass.status, runId: pass.runId, startedAt: pass.startedAt, endedAt: pass.endedAt, doneKeys: pass.keys, added: pass.added, skipped: pass.skipped, output: pass.output, error: pass.error })) } } : {}), children: state.fanout.children.map((child) => ({ key: child.key, status: child.status, runId: child.runId, ...(child.error ? { error: child.error } : {}), ...(child.previous.length ? { previous: child.previous.map((entry) => ({ runId: entry.runId, status: entry.status, reason: entry.reason })) } : {}) })), passes: state.fanoutPast.length } }
              : {}),
            ...(state.status === "skipped" ? { skipped: run.history.findLast((event) => event.type === "step_skipped" && event.stepId === id)?.detail ?? null } : {}),
            report: attempt?.report ?? null,
            lastMessage: attempt?.report ? null : attempt?.lastMessage ?? null,
            turnEnd: attempt?.turnEnd ?? null,
            ...(slow[step.id] ? { slow: slowEntry(run, step.id, slow[step.id]!) } : {}),
            outputs: state.outputs,
            summary: state.summary,
          },
        ];
      }),
    ),
    gates: run.gates,
    loops: run.loops,
    ...(run.jobs.length > 0 || run.batch ? { jobs: jobStatus(run, true) } : {}),
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
  const waiting = run.gates.some(waitsForHuman);
  return ` After-tasks running: ${running.join(", ")} (their result does not change the run, which stays ${run.status}). ${
    waiting ? "A gate is waiting for a human decision. " : ""
  }Ready: ${engine.readyList(run, ready) || "none"}.${gates.length ? ` Gate(s) to open with request_gate: ${gates.join(", ")}.` : ""}`;
}

/** A step's conditions as the agent tools show them: operand → values, or `{ empty }`. */
function whenView(conditions: When[]) {
  return Object.fromEntries(
    conditions.map((condition) => [condition.input, condition.empty !== undefined ? { empty: condition.empty } : condition.loop ? condition.loop.map((test) => `${test.op}${test.value}`) : condition.values]),
  );
}

function describeEntry(entry: PlaybookEntry) {
  if (!entry.playbook) return { id: entry.id, repo: entry.repo, file: entry.file, valid: false, errors: entry.errors };
  const pb = entry.playbook;
  return {
    id: pb.id,
    repo: entry.repo,
    file: pb.file,
    valid: true,
    title: pb.title,
    description: pb.description,
    hidden: entry.hidden,
    inputs: pb.inputs,
    outputs: Object.fromEntries(Object.entries(pb.outputs).map(([name, def]) => [name, { type: def.type, from: def.label }])),
    concurrency: pb.concurrency ?? null,
    ...(pb.singleton
      ? (() => {
          const stages = pb.singleton.stages.map((stage) => ({ id: stage.id, needs: stage.needs, queue: stage.mode, retries: stage.retries }));
          // `stations` is the deprecated name of `stages`, until the end of the aliases (ADR 2026-11-12-stage-batch-rename).
          return { singleton: { branch: pb.singleton.branch ?? "(default branch)", stages, stations: stages } };
        })()
      : {}),
    after: pb.after.map((task) => ({ id: task.id, title: task.title, trigger: task.trigger, steps: task.steps })),
    steps: pb.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      ...(step.description ? { description: step.description } : {}),
      role: step.role ? `${step.role} (${pb.roles[step.role]!.title}${pb.roles[step.role]!.readonly ? ", readonly" : ""})` : null,
      gate: step.gate ?? null,
      ...(step.kind === "script" ? { script: step.script, poll: step.pollMs ? `${step.pollMs / 1000}s` : null } : {}),
      ...(step.kind === "handoff" ? { handoff: step.handoff } : {}),
      ...(step.fanout ? { fanout: { playbook: step.fanout.playbook, maxActive: step.fanout.maxActive, cancelChildren: step.fanout.cancelChildren, ...(step.fanout.pool ? { pool: { refill: { playbook: step.fanout.pool.playbook, itemsOutput: step.fanout.pool.itemsOutput, after: step.fanout.pool.after, maxRefills: step.fanout.pool.maxRefills, debounceMs: step.fanout.pool.debounceMs } } } : {}) } } : {}),
      ...(step.when ? { when: whenView(step.when) } : {}),
      ...(step.branch ? { branch: step.branch.cases.map((candidate) => (candidate.when ? { case: candidate.name, if: whenView(candidate.when) } : { case: candidate.name, else: true })) } : {}),
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

/**
 * `list_playbooks` and `validate_playbooks` views. The full description of every playbook easily passes the
 * 100K-character tool-result limit, so the default is compact; `results[].valid` and `results[].id` are in both.
 */
export const PlaybookViewSchema = z
  .enum(["compact", "full"])
  .default("compact")
  .describe('"compact" (default): per playbook id, valid, title, errors, inputs and step ids. "full": everything (steps, roles, wiring), which can be very large; combine with playbookId.');

export function describeEntries(entries: PlaybookEntry[], view: "compact" | "full", playbookId?: string): unknown[] {
  const picked = playbookId ? entries.filter((entry) => entry.id === playbookId) : entries;
  if (playbookId && picked.length === 0) throw new UserError(`No playbook "${playbookId}" (known: ${entries.map((entry) => entry.id).join(", ") || "none"}).`);
  return picked.map((entry) => {
    if (view === "full") return describeEntry(entry);
    const pb = entry.playbook;
    return {
      id: entry.id,
      valid: pb !== null,
      errors: entry.errors,
      ...(pb ? { title: pb.title, hidden: entry.hidden, inputs: Object.keys(pb.inputs), steps: pb.steps.map((step) => step.id), after: pb.after.map((task) => task.id) } : {}),
    };
  });
}

/** Error for a `request_gate` call without `summary`. */
export function gateSummaryMissing(stepId: string): string {
  return `request_gate needs a "summary" for gate "${stepId}": one short sentence (at most ${GATE_SUMMARY_MAX} characters) saying what the human decides. Put what was done, links and risks in "details". (Feedback for a loop goes in complete_step's "summary", not here.)`;
}

const IdArg = z.string().describe("Run id returned by start_playbook");

/** One line on where an isolated run's playbook came from; a warning when it is the workspace checkout's. */
export function definitionNote(run: Pick<Run, "definition">): string {
  const def = run.definition;
  if (!def) return "";
  if (def.source === "origin") return `\nPlaybook definition and roles: read from ${def.ref} at ${def.sha?.slice(0, 10) ?? "?"} (fetched at start), not from the workspace checkout.`;
  return `\nWARNING: playbook definition and roles come from the workspace checkout, which may be behind origin: ${def.note ?? "no fresh copy was used"}.`;
}

/** The two manager-tools a Sidekick also gets (it manages no run, so not the others): see which runs it can start. */
export const SIDEKICK_MANAGER_TOOLS = ["list_playbooks", "start_playbook", "replace_child"];

/** The part of the manager tools given to a Sidekick: list_playbooks and start_playbook (with workspaceId, newWorkspace, forJob). */
export function sidekickStartTools(runtime: Runtime): AgentToolDefinition[] {
  return managerTools(runtime).filter((tool) => SIDEKICK_MANAGER_TOOLS.includes(tool.name));
}

export function managerTools(runtime: Runtime): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "list_playbooks",
      description:
        'List the playbooks of this workspace and explain how a Playbook Manager runs them. Compact by default (id, valid, title, errors, input names, step ids); pass playbookId, or view "full", for inputs, steps, roles and wiring in detail.',
      input: z.object({
        view: PlaybookViewSchema,
        playbookId: z.string().optional().describe("Only this playbook"),
      }),
      execute: ({ view, playbookId }, { agent }) =>
        guard(async () => {
          const projectId = await runtime.projectIdOf(agent.workspaceId);
          const loaded = await loadPlaybooks(agent.cwd, projectId ? { projectId } : {});
          const playbooks = describeEntries(loaded.entries, playbookId ? "full" : view, playbookId);
          return ok(`${MANAGER_PROTOCOL}\n\nPlaybooks:\n${JSON.stringify(playbooks, null, 2)}`, { playbooks });
        }),
    }),
    defineAgentTool({
      name: "start_playbook",
      description:
        "Create a run of a playbook with its own Playbook Manager: you do not manage it, you follow it through your event subscription and list_runs. Where it starts depends on the playbook. A playbook with `isolation: { mode: worktree }` starts IN YOUR WORKSPACE (or in workspaceId) in the run's private worktree, so several runs share the workspace and show in its Playbook panel; pass newWorkspace: true to force a new workspace instead. Any other playbook ALWAYS starts in a NEW workspace (a new branch off the current one, or off workspaceId's), never joining yours or an existing one; newWorkspace: false is refused for it. A Sidekick (no workspace of its own) always gets a new workspace, unless it passes workspaceId of an existing workspace for an isolated playbook. Returns the run id and the workspace. The only other exception: a Playbook Manager the plugin created for a run, which creates that run in its own reserved workspace by calling this with no workspace arguments.",
      input: z.object({
        playbook: z.string().describe("Playbook id (its file name without .yaml)"),
        inputs: z.record(z.string(), VarValueSchema).default({}).describe("Playbook inputs by name"),
        name: z
          .string()
          .optional()
          .describe('A short name for the run, 2 to 4 words saying what this run is about (e.g. "login-redirect-fix", "PROJ-412 retry"); it labels the run in the panel. At most 32 characters'),
        newWorkspace: z
          .boolean()
          .optional()
          .describe("true: force a new workspace. false: start in your workspace (or workspaceId), accepted only for a playbook with `isolation: { mode: worktree }`. Omitted: your workspace for an isolated playbook, a new workspace for any other (and always for a Sidekick without workspaceId). A Playbook Manager the plugin created for this run omits it"),
        workspaceId: z
          .string()
          .optional()
          .describe("A workspace of this project (list_workspaces) instead of yours: the run starts in it for an isolated playbook (unless newWorkspace: true), otherwise the NEW workspace is branched off it. Optional: a Sidekick may omit it (the new workspace branches off the project's root; an isolated run in an existing workspace needs it)"),
        workspaceName: z
          .string()
          .max(200)
          .optional()
          .describe("With newWorkspace: the title of the new workspace (trimmed to one line, at most 80 characters; default: the playbook title and the request). It does not change the branch name"),
        forJob: z
          .string()
          .optional()
          .describe("A batch manager starting the follow-up (rework) of a detached job it settled with an outcome (ejected...): its job id. The plugin records the run you start as that job's follow-up (record_followup, get_run `jobs[].followUps`) so the batch is not left with a hand-off pending. Works whether the run starts in a workspace of its own or in yours (isolated playbook)"),
        replaces: z
          .string()
          .optional()
          .describe("A fan-out child run this run replaces (e.g. you restart your own run, canceling it and starting a new one for the same item): its run id. The new run is attached to the same item of the parent's fan-out (same key, same slot), the replaced run is canceled if still active, and the fan-out ends only when the last run of the item's chain does. The new run must be of the same playbook (its inputs may differ). Refused if the run is not a child of a running fan-out step. Starts in a new workspace, like forJob"),
        replaceReason: z.string().max(500).optional().describe("With replaces: why (shown in the item's chain, get_run, the events and the Playbooks panel)"),
        autoStart: z
          .boolean()
          .default(true)
          .describe("Start the run's ready agent steps right away, as start_step would with no brief (default true). false: leave them ready; with workspaceId or a Sidekick, the new manager then waits to be told to start them"),
      }),
      execute: ({ playbook, inputs, name, newWorkspace: requested, workspaceId, autoStart, workspaceName, forJob, replaces, replaceReason }, { agent }) =>
        guard(async () => {
          const sidekick = await runtime.isSidekick(agent.id);
          // New workspace by default. Exceptions: a Playbook Manager the plugin created for a reserved workspace creates its run there;
          // an isolated playbook (isolation.mode: worktree) starts in the caller's workspace (workspaceId), unless newWorkspace: true.
          // A Sidekick has no workspace to start in: only an explicit workspaceId.
          const reserved = !sidekick && !workspaceId && runtime.hasReservationFor(agent.workspaceId, playbook, inputs);
          const target = workspaceId ?? (sidekick ? null : agent.workspaceId);
          const inPlace = !reserved && requested !== true && target !== null && (await runtime.isIsolatedPlaybook(target, playbook));
          if (requested === false && !reserved && !inPlace)
            throw new UserError(
              `newWorkspace: false is refused: only a playbook with \`isolation: { mode: worktree }\` starts in ${sidekick ? "an existing workspace (pass workspaceId)" : "your workspace"}. This run starts in a NEW workspace: omit newWorkspace (or pass true); workspaceId then only names the workspace the new one is branched off`,
            );
          const newWorkspace = reserved ? (requested ?? false) : !inPlace;
          if (forJob) {
            if (!newWorkspace && !inPlace) throw new UserError("forJob records the run you start as the job's follow-up: it starts in a new workspace, not as your own run");
            runtime.checkFollowUp(forJob);
          }
          if (replaces) {
            if (!newWorkspace && !inPlace) throw new UserError("replaces attaches the run you start to a fan-out item: it starts in a new workspace, not as your own run");
            runtime.checkReplacement(replaces, playbook);
          }
          const afterStart = async (started: { runId: string }) => {
            if (forJob) await runtime.recordFollowUp(forJob, { runId: started.runId, note: null, by: agent.id });
            if (replaces) await runtime.replaceChild({ runId: replaces, newRunId: started.runId, reason: replaceReason ?? null, by: agent.id, cancelBy: runtime.allRuns().find((run) => run.id === replaces)?.managerAgentId === agent.id ? null : `by agent ${agent.id}` });
          };
          if (workspaceName?.trim() && !newWorkspace) throw new UserError("workspaceName names a new workspace: it does not apply to a run that starts in an existing one (your reserved workspace, or an isolated run in yours)");
          if (inPlace) {
            const started = await runtime.startPlaybookInWorkspace(agent, { playbook, inputs, workspaceId: target!, newWorkspace: false, autoStart });
            await afterStart(started);
            return ok(
              `Run ${started.runId} of "${playbook}" is starting in workspace ${started.workspaceId}, in its own private worktree (isolation: worktree), with ${started.managerAgentId ? `its own Playbook Manager (${started.managerAgentId})` : "no Playbook Manager (manager.mode: none): the plugin drives it"}. It shows in that workspace's Playbook panel next to its other runs. You do not manage it: the plugin tells you how it goes through your event subscription (list_runs shows it).`,
              started,
            );
          }
          if (workspaceId || sidekick) {
            const started = await runtime.startPlaybookInWorkspace(agent, { playbook, inputs, workspaceId, newWorkspace: true, autoStart, workspaceName });
            await afterStart(started);
            return ok(
              `Run ${started.runId} of "${playbook}" is starting in a new workspace ${started.workspaceId} with ${started.managerAgentId ? `its own Playbook Manager (${started.managerAgentId})` : "no Playbook Manager (manager.mode: none): the plugin drives it"}. You do not manage it: the plugin tells you how it goes through your event subscription (list_runs shows it).`,
              started,
            );
          }
          if (newWorkspace) {
            const started = await runtime.startPlaybookElsewhere(agent, playbook, inputs, workspaceName);
            await afterStart(started);
            return ok(
              `Run ${started.runId} of "${playbook}" is starting in a new workspace (${started.workspaceId}) with ${started.managerAgentId ? `its own Playbook Manager (${started.managerAgentId})` : "no Playbook Manager (manager.mode: none): the plugin drives it"}. You do not manage it: carry on with your own run.`,
              started,
            );
          }
          const run = await runtime.startPlaybook(agent, playbook, inputs, { name, hold: !autoStart });
          if (run.playbook.singleton) {
            return ok(
              `"${playbook}" is a singleton: its pipeline is run ${run.id}, in its own workspace. Hand-off steps give it jobs; each stage's batches get their own Playbook Manager there. You do not manage it.`,
              { runId: run.id, status: run.status },
            );
          }
          if (run.managerAgentId === "") {
            return ok(
              `Run ${run.id} of "${playbook}" started on branch ${run.branch ?? "(unknown)"} with no Playbook Manager (manager.mode: none): you do not manage it. The plugin starts its steps, applies their reports, opens its gates (a human decides them in the Playbooks panel) and stops the run in its failed state on a failure (autoStart does not apply). It tells you how it goes through your event subscription; list_runs and get_run show it.`,
              runListing(run),
            );
          }
          const instructions = managerInstructionsText(run.playbook);
          const auto = autoStart ? await runtime.autoStartReady(agent.id, run.id) : null;
          const current = runtime.ownedRun(agent.id, run.id);
          const pending = engine.readySteps(current).filter((id) => !auto?.started.some((s) => s.stepId === id));
          const startedText = auto?.started.length
            ? ` Already started (autoStart): ${auto.started.map((s) => `${s.stepId} (agent ${s.agentId}, attempt ${s.attempt})`).join(", ")}; do not start_step them again.`
            : "";
          const failedText = auto?.failed.length ? ` Could not start: ${auto.failed.map((f) => `${f.stepId} (${f.error})`).join("; ")}.` : "";
          return ok(
            `Run ${run.id} started on branch ${run.branch ?? "(unknown)"}.${startedText}${failedText} Ready${auto ? " and not started" : ""}: ${pending.join(", ") || "none"}.${pending.length ? " Start them with start_step." : auto?.started.length ? " End your turn; you will be woken when a step finishes." : ""}${run.worktree ? `\n\n${worktreePreamble(run)}\n` : ""}${definitionNote(run)}${engine.queuedSteps(run).length ? ` Queued for a free concurrency slot of another run: ${engine.queuedSteps(run).join(", ")}; you are woken when they are ready.` : ""}${instructions ? `\n\n${instructions}` : ""}`,
            runChange(run),
          );
        }),
    }),
    defineAgentTool({
      name: "start_step",
      description: `Start a ready agent step as a subagent. The plugin renders the step prompt and inputs; your brief adds context they lack. ${MODEL_USE}`,
      input: z.object({ runId: IdArg, stepId: z.string(), brief: z.string().default("").describe("Short brief for the step agent"), ...ModelArgs }),
      execute: ({ runId, stepId, brief, model, thinking }, { agent }) =>
        guard(async () => {
          const started = await runtime.startStep(agent.id, runId, stepId, brief, modelChoice(model, thinking));
          return ok(
            `Step "${stepId}" attempt ${started.attempt} started on ${started.target} (agent ${started.agentId}).${started.skipped?.length ? ` Skipped by provider usage: ${started.skipped.join("; ")}.` : ""} End your turn; you will be woken when it finishes.`,
            started,
          );
        }),
    }),
    defineAgentTool({
      name: "complete_step",
      description: "Decide the outcome of a reported step (not for an outcome the step lists under role.completion.auto: the plugin applies those itself, and refuses this call for them). The plugin applies the playbook's transition and returns what is ready next, a gate, or the end of the run.",
      input: z.object({
        runId: IdArg,
        stepId: z.string(),
        outcome: z.string().describe("One of the step's outcomes"),
        summary: z.string().optional().describe("Overrides the step's summary. On a transition that loops back (goto), this summary is the feedback the target step receives: put loop feedback here, not in outputs (outputs only accept the step's declared ones)"),
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
                  : `Ready: ${engine.readyList(run, ready) || (queued.length ? "none" : "none (waiting for running steps)")}.${queued.length ? ` Queued for a free concurrency slot of another run: ${queued.join(", ")}; end your turn, you are woken when they are ready.` : ""}${gates.length ? ` Gate(s) to open with request_gate: ${gates.join(", ")}.` : ""}`;
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
        // Optional in the schema so a call that lost it gets a specific error rather than "expected string, received undefined".
        summary: z
          .string()
          .max(GATE_SUMMARY_MAX, `One short sentence (at most ${GATE_SUMMARY_MAX} characters); put everything else in details`)
          .optional()
          .describe(`Required: one short sentence (at most ${GATE_SUMMARY_MAX} characters): what the human decides, e.g. "PR #3 is green and ready to merge."`),
        details: z.string().default("").describe("What was done, links, risks, follow-ups (collapsed under the summary)"),
      }),
      execute: ({ runId, stepId, summary, details }, { agent }) =>
        guard(async () => {
          if (!summary) throw new UserError(gateSummaryMissing(stepId));
          const gate = await runtime.requestGate(agent.id, runId, stepId, summary, details);
          const step = runtime.ownedRun(agent.id, runId).playbook.steps.find((candidate) => candidate.id === gate.stepId);
          return ok(`Gate ${gate.id} is open in the Paseo panel. ${askHumanText(gate, choicesOfGate(gate, step))}`, gate);
        }),
    }),
    defineAgentTool({
      name: "resume",
      description:
        "Record a gate decision that reached you by chat (e.g. a Slack reply), or, with byManager, your own decision on a gate the playbook lets you decide. If the panel already decided, returns that decision.",
      input: z.object({
        runId: IdArg,
        stepId: z.string().describe("Gate step id or gate id"),
        decision: z.string().describe('One of the gate\'s choices (by default "approved" or "rejected"; an ask gate\'s are "answered" or its declared choices)'),
        comment: z.string().optional(),
        decidedBy: z.string().optional().describe("Who decided, e.g. a Slack user id"),
        byManager: z
          .boolean()
          .default(false)
          .describe("You decide yourself, without a human: only on a gate whose decider is the manager; comment (your reason) is then required"),
      }),
      execute: ({ runId, stepId, decision, comment, decidedBy, byManager }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          const result = await runtime.decideGate(runId, stepId, {
            decision,
            comment: comment ?? null,
            by: byManager ? "manager" : decidedBy ?? null,
            via: byManager ? "manager" : "chat",
            now: new Date().toISOString(),
          });
          const run = (await runtime.ownedRun(agent.id, runId))!;
          const prefix = result.alreadyDecided ? `Already decided: ${result.gate.status} via ${result.gate.decidedVia}.` : `Recorded ${decision}.`;
          return ok(`${prefix} Run is ${run.status}.${afterText(run)} Ready: ${engine.readyList(run, engine.readySteps(run)) || "none"}.${engine.queuedSteps(run).length ? ` Queued for a free concurrency slot: ${engine.queuedSteps(run).join(", ")}.` : ""}`, runChange(run, result.gate.stepId));
        }),
    }),
    defineAgentTool({
      name: "escalate_gate",
      description:
        "On a gate whose decider is the manager: tell the plugin you leave it to a human, with your reason, right before you ask the human in chat. It records the hand-over (agents subscribed to gate.escalated are told) and the gate then works as a human gate. Refused on other gates.",
      input: z.object({
        runId: IdArg,
        stepId: z.string().describe("Gate step id or gate id"),
        reason: z.string().describe("Why you do not decide it yourself, in one or two sentences"),
      }),
      execute: ({ runId, stepId, reason }, { agent }) => guard(async () => ok(await runtime.escalateByManager(agent.id, runId, stepId, reason))),
    }),
    defineAgentTool({
      name: "nudge_step",
      description: `Send a follow-up message to a step's current agent (same conversation, no new attempt), e.g. when it ended without reporting. On a step that timed out, its next report replaces the timeout failure. With model: an agent cannot change model, so a new agent on that model takes over the same attempt (no retry used, the old agent is archived), started with the step's prompt, a hand-over note and your message; use it when the step stopped because its provider is out of tokens (its last message says "usage limit", "weekly limit", "rate limit"...) and no fallback took over. Refused once the attempt has reported. ${MODEL_USE}`,
      input: z.object({ runId: IdArg, stepId: z.string(), message: z.string(), ...ModelArgs }),
      execute: ({ runId, stepId, message, model, thinking }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          const moved = await runtime.nudgeStep(runId, stepId, message, false, modelChoice(model, thinking));
          if (moved) return ok(`"${stepId}" moved to ${moved.target} (agent ${moved.agentId}), same attempt. End your turn; you will be woken when it finishes.`, moved);
          return ok(`Sent to "${stepId}". End your turn; you will be woken when it finishes.`);
        }),
    }),
    defineAgentTool({
      name: "settle_job",
      description:
        "Batches of a singleton pipeline: settle one job your batch carries (see get_run `jobs`, or {{ run.jobs }} in the step prompts). Without outcome: set its outputs (e.g. a release tag later stages read); it goes on with the batch. With an outcome of the singleton (e.g. ejected): it ends now and the run that handed it off is told at once; the batch goes on with the others. What an outcome does is declared by the playbook (settle.effects of the stage's settle step, see get_run): it ends the job (default), continues it in the batch, or requeues it: the job leaves this batch and goes back to its stage's queue with no failed ride (summary is the reason, blocker an optional opaque string it waits for; the stage's queue.max_requeues caps how often, past it the job fails). A requeued job is no longer in {{ run.jobs }}. Jobs still open when the batch completes pass to the next stage.",
      input: z.object({
        runId: IdArg,
        jobId: z.string(),
        outcome: z.string().optional().describe("One of the singleton's outcomes (ends the job, continues it or requeues it, as the playbook declares); omit to only set outputs"),
        summary: z.string().describe("What happened to this job, for the run that handed it off (for a requeue: why it goes back)"),
        blocker: z.string().optional().describe("Only with an outcome that requeues: what the job waits for (any text, e.g. a URL); stored and shown, never interpreted"),
        outputs: z.record(z.string(), VarValueSchema).default({}).describe("The playbook's outputs for this job"),
      }),
      execute: ({ runId, jobId, outcome, summary, outputs, blocker }, { agent }) =>
        guard(async () => {
          const run = await runtime.settleJob(agent.id, runId, jobId, { outcome, summary, outputs, blocker });
          const open = run.jobs.filter((job) => job.status === "open" && !job.requeued).map((job) => job.id);
          return ok(
            run.jobs.find((job) => job.id === jobId)?.requeued
              ? `Job ${jobId} requeued: it left this batch and waits at its stage again (no failed ride). Open jobs on this batch: ${open.join(", ") || "none"}.`
              : outcome === undefined
              ? `Outputs of job ${jobId} set; it goes on with the batch. Open jobs: ${open.join(", ") || "none"}.`
              : `Job ${jobId} ended with "${outcome}"; its run was told. Open jobs on this batch: ${open.join(", ") || "none"}.`,
            runChange(run),
          );
        }),
    }),
  ];
}

/** One line per run for agents that do not manage it. */
export function runListing(run: Run, slow: Record<string, SlowInfo> = {}) {
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
    ...worktreeView(run),
    managerAgentId: run.managerAgentId,
    /** `none`: no manager agent; the plugin drives the run (managerAgentId is empty). */
    managerMode: run.playbook.managerMode,
    createdAt: run.createdAt,
    runningSteps: Object.entries(run.steps).filter(([, state]) => state.status === "running").map(([id]) => id),
    /** Steps slower than usual (shared/slow.ts), and how much. */
    slowSteps: Object.keys(slow),
    ...(Object.keys(slow).length > 0 ? { slow: slowEntries(run, slow) } : {}),
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

/** Tools for every agent except step agents: find runs, cancel, archive and restart them, e.g. when the human asks in any chat. */
export function runTools(runtime: Runtime): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "list_runs",
      description:
        "List playbook runs on this Paseo daemon (by default only active ones): id, playbook, status, workspace, branch, manager, running steps, `slowSteps` (steps slower than usual, with `slow` detail: elapsedMs, baselineMs, factor, ratio, samples, running) and where a finished run can be restarted from. slow: true lists only the runs with a step that is slow right now, e.g. to answer \"which steps take longer than usual\".",
      input: z.object({
        all: z.boolean().default(false).describe("Include finished runs that are not archived"),
        archived: z.boolean().default(false).describe("Also include archived runs (archiving a manager archives its runs)"),
        slow: z
          .boolean()
          .default(false)
          .describe("Only runs with a step that is slow right now (running longer than `factor` times its usual duration: the \"attention\" triangle of the panel), each with its slow steps. The usual duration is the mean of the step's last completed runs on the whole history."),
      }),
      execute: ({ all, archived, slow }) =>
        guard(async () => {
          const every = runtime.allRuns();
          const index = new SlowIndex(every);
          const now = Date.now();
          const rows = every.filter((run) => (archived || !run.archivedAt) && (slow || all || archived || isActive(run))).map((run) => ({ run, slow: index.of(run, now) }));
          const runs = rows
            .filter(({ run, slow: found }) => !slow || (!run.archivedAt && Object.keys(found).some((id) => run.steps[id]?.status === "running")))
            .map(({ run, slow: found }) => runListing(run, found));
          return ok(runs.length === 0 ? (slow ? "No step is slow right now." : all || archived ? "No runs." : "No active run.") : JSON.stringify(runs, null, 2), { runs });
        }),
    }),
    defineAgentTool({
      name: "get_run",
      description:
        'Show a run\'s state. Read-only on a run you do not manage (any run id works); the tools that change it refuse it. Without runId, your active (or latest) run. view "compact" (default): per step its status, outcome, attempts, turn end and the start of its summary, plus gates, loops and after-tasks. view "full": every step\'s definition, full report, outputs and summary, the run inputs and the gates in full (e.g. for a retro brief). steps limits either view to those steps. A step slower than usual (the "attention" triangle of the panel) has `slow` {elapsedMs, baselineMs, factor, ratio, samples, running}; `slowSteps` lists them.',
      input: z.object({
        runId: IdArg.optional(),
        view: z.enum(["compact", "full"]).default("compact").describe('"compact" (default) or "full" (reports, outputs, inputs, gate details)'),
        steps: z.array(z.string()).optional().describe("Only these step ids (default: all)"),
      }),
      execute: ({ runId, view, steps }, { agent }) =>
        guard(async () => {
          const run = runtime.readableRun(agent.id, runId);
          if (run.managerAgentId === agent.id) await runtime.clearInbox(run.id);
          const slow = new SlowIndex(runtime.allRuns()).of(run);
          const summary = view === "full" ? runFull(run, steps, slow) : runCompact(run, steps, slow);
          return ok(JSON.stringify(summary, null, 2), summary);
        }),
    }),
    defineAgentTool({
      name: "read_agent_conversation",
      description:
        "Read another agent's conversation as plain text, oldest first: what the user asked, what the agent answered, its tool calls (name and status; the input too with includeToolDetail), and its reasoning with includeReasoning. Reads the newest `limit` entries (default 60). When hasOlder is true, pass the returned `before` back to read the entries before them. Read-only; works on any agent of the daemon (a step agent, a manager, a subagent), running or finished. Use it to see what an agent did and whether it is stuck, instead of handing a transcript to a subagent.",
      input: z.object({
        agentId: z.string().describe("The agent to read"),
        limit: z.number().int().min(1).max(200).default(60).describe("Timeline entries to read (default 60); streamed messages count several"),
        before: z.object({ epoch: z.string(), seq: z.number().int() }).optional().describe("The `before` of a previous call: read the entries before it"),
        includeReasoning: z.boolean().default(false).describe("Also show the agent's reasoning"),
        includeToolDetail: z.boolean().default(false).describe("Also show each tool call's input and output (clipped)"),
        maxChars: z.number().int().min(100).max(20000).default(2000).describe("Characters kept per message or detail (default 2000)"),
      }),
      execute: ({ agentId, limit, before, includeReasoning, includeToolDetail, maxChars }) =>
        guard(async () => {
          const page = await runtime.readTimeline(agentId, { limit, before });
          const text = conversationText(page.entries as never, { includeReasoning, includeToolDetail, maxChars });
          const result = { agentId, hasOlder: page.hasOlder, before: page.hasOlder ? page.startCursor : null, entries: page.entries.length };
          return ok(`${text || "(nothing to show in these entries)"}\n\n${JSON.stringify(result)}`, result);
        }),
    }),
    defineAgentTool({
      name: "get_analytics",
      description:
        "Where the tokens went, summed over the runs on this daemon (archived ones too), to find how to make playbooks cheaper or better: totals, and breakdowns by playbook, step (with its role and model), role and model, each with attempts, wasted attempts (retried, or whose agent did not finish) and their tokens, input / cached input / output tokens, and peak context. overhead is the managers' and gate deciders' share. topAgents lists the agents that spent the most (most tokens first; id, title, kind: step, decider, manager, sidekick or other, an agent outside the runs; role, model, turns, input / cached / output tokens, peak context), to find the real drains. Read-only. Use it to spot steps that use the most tokens, retry the most, or run a bigger model than they need, then propose a change to the playbook, role or model.",
      input: z.object({
        days: z.number().int().positive().optional().describe("Only runs created in the last N days (default: all)"),
        playbook: z.string().optional().describe("Only runs of this playbook name"),
        projectId: z.string().optional().describe("Only runs of this project"),
        limit: z.number().int().positive().max(200).optional().describe("Rows per breakdown (default 25, the most expensive first)"),
      }),
      execute: (input) =>
        guard(async () => {
          const result = await runtime.analytics(input);
          return ok(JSON.stringify(result, null, 2), result);
        }),
    }),
    defineAgentTool({
      name: "list_gates",
      description:
        "List what waits for a decision across all playbook runs, oldest first: every open gate and ask (run, playbook, workspace, step, kind, question, choices, decider, who holds it now, opened-at and age in minutes). With includeFailed, also the runs that failed or lost their manager, with the reason and restartableFrom. Read-only; compact and stable, so a scheduled agent can call it and compare. Decide a gate with resume (its run's manager or a human in the panel), not here.",
      input: z.object({
        runId: IdArg.optional().describe("Only this run"),
        olderThanMinutes: z.number().min(0).optional().describe("Only gates open at least this long"),
        includeFailed: z.boolean().default(false).describe("Also list failed runs (and runs that lost their manager)"),
        includeFinished: z.boolean().default(false).describe("Also gates of runs that have ended (an after-task's gate)"),
      }),
      execute: (filter) =>
        guard(async () => {
          const result = runtime.attention(filter);
          return ok(attentionText(result), result);
        }),
    }),
    defineAgentTool({
      name: "subscribe_events",
      description:
        'Get a plain-text message from the plugin when events happen on the daemon. types: exact names or globs ("gate.*", "run.failed", "*"). Types today: gate.opened (a gate step, ask or loop-limit gate opened: question, choices, decider and who holds it), gate.stale (still open after filter.olderThanMinutes, default 30; once per gate), gate.decided (who, via panel/chat/manager/role, and the comment; not sent to the manager or role agent that decided it), run.failed (reason and restartableFrom), run.manager_lost, step.started (stepId, attempt), step.completed (stepId, attempt, outcome: every applied outcome, failures and retried ones included; gate and branch steps too, those without step.started), step.slow (a running step first went past factor x its usual duration: elapsedMs, baselineMs, ratio, samples; once per step run), run.completed, run.canceled (reason). Step and run events carry runId, playbook, runName, projectId, workspaceDir. filter: payload fields that must equal a value (e.g. { playbook: "release", deciderBy: "role" }, { runId }), plus olderThanMinutes for gate.stale. Bursts are merged into one message. delivery: "idle" (default) holds the message until your current turn has ended, then sends it as one new message, so it never interrupts you (an interactive question, say); "steer" sends it into your running turn at once. Held messages survive restarts (at most 50 per subscription; older ones are dropped, list_events replays them). The subscriber is you; it survives daemon restarts and ends when you are archived. Returns the subscription id. list_events replays what you missed. A new subscription must be scoped: pass filter { runId } (or { workspaceDir } for runs you drive; projectId or playbook also work); only gate.escalated, run.failed and run.manager_lost may be unscoped. Avoid step.completed unless you need it: it fires on every step.',
      input: z.object({
        types: z.array(z.string()).min(1).describe('Event types or globs, e.g. ["gate.*", "run.failed"]'),
        filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}).describe("Payload fields to match by equality; olderThanMinutes picks the delay of a stale event"),
        delivery: z.enum(["idle", "steer"]).default("idle").describe('"idle" (default): held until your turn ends; "steer": injected into your running turn'),
      }),
      execute: ({ types, filter, delivery }, { agent }) =>
        guard(async () => {
          checkSubscriptionScope(types, filter);
          const sub = await runtime.subscribeEvents(agent.id, types, filter, delivery);
          return ok(`Subscribed (${sub.id}) to ${sub.types.join(", ")}. You get a "[playbooks]" message when one happens; list_gates shows what is open now, list_events what happened.`, { subscription: sub });
        }),
    }),
    defineAgentTool({
      name: "unsubscribe_events",
      description: "Stop a subscription of yours (see list_subscriptions).",
      input: z.object({ id: z.string().describe("Subscription id from subscribe_events") }),
      execute: ({ id }, { agent }) =>
        guard(async () => {
          await runtime.unsubscribeEvents(agent.id, id);
          return ok(`Subscription ${id} removed.`);
        }),
    }),
    defineAgentTool({
      name: "list_subscriptions",
      description: "List your event subscriptions (subscribe_events): id, types, filter, delivery and sink.",
      input: z.object({}),
      execute: (_input, { agent }) =>
        guard(async () => {
          const subscriptions = await runtime.bus.list(agent.id);
          return ok(subscriptions.length === 0 ? "No subscription." : JSON.stringify(subscriptions, null, 2), { subscriptions });
        }),
    }),
    defineAgentTool({
      name: "list_events",
      description:
        "The recent events log (the last 500, kept across restarts), oldest first, each with a monotonic seq, type, time, run and payload. Pass since: the seq of the last event you saw to catch up on what you missed (after a restart, or when you were down); lastSeq is the newest. types takes exact names or globs. Without since: the last `limit` events. If oldestSeq is above your since + 1, older events were dropped.",
      input: z.object({
        since: z.number().int().min(0).optional().describe("Only events with a seq above this"),
        types: z.array(z.string()).optional().describe('Exact names or globs, e.g. ["gate.*"]'),
        limit: z.number().int().min(1).max(500).optional().describe("At most this many (default 50)"),
      }),
      execute: (query) =>
        guard(async () => {
          const result = await runtime.bus.recent(query);
          return ok(result.events.length === 0 ? `No event${query.since === undefined ? "" : ` after ${query.since}`}. lastSeq: ${result.lastSeq}.` : JSON.stringify(result, null, 2), result);
        }),
    }),
    defineAgentTool({
      name: "replace_child",
      description:
        "A child run of a fan-out step (a run whose parent is a fan-out item, get_run on the parent lists them) was replaced by a NEW run of the same playbook (e.g. its manager canceled it and started another for the same ticket): link them. newRunId (start_playbook gives it; it may still be starting) becomes the current run of runId's item: same key, same slot (max_active is not charged twice), and the item stays running; the fan-out ends only when the last run of the item's chain ends, and the replaced run is not counted as a failure of the item. runId is canceled if it is still active. get_run on the parent shows `children[].previous` (run, status, reason). Callable by the child's manager, the parent's manager or any other agent. Also: start_playbook with `replaces` starts and links in one call; restart_run of a child needs no call (the item follows its run). Refused when runId is not a child of a RUNNING fan-out step (an ended fan-out is not reopened), when newRunId is of another playbook, or already belongs to another item. Idempotent: repeating the same link changes nothing (changed: false); replacing a run that was already replaced by another is refused (pass the current run). Emits fanout.child_replaced.",
      input: z.object({
        runId: IdArg.describe("The child run being replaced"),
        newRunId: IdArg.describe("The run that replaces it"),
        reason: z.string().max(500).optional().describe("Why (e.g. \"Restarting on the fixed playbook\"); shown in the chain"),
      }),
      execute: ({ runId, newRunId, reason }, { agent }) =>
        guard(async () => {
          const old = runtime.allRuns().find((run) => run.id === runId);
          const wasActive = old !== undefined && !isTerminal(old.status);
          const result = await runtime.replaceChild({ runId, newRunId, reason: reason ?? null, by: agent.id, cancelBy: old?.managerAgentId === agent.id ? null : `by agent ${agent.id}` });
          return ok(
            result.changed
              ? `Run ${newRunId} now replaces ${runId} as item "${result.key}" of fan-out step "${result.stepId}" of run ${result.parentRunId}${wasActive ? " (the replaced run was canceled)" : ""}. Earlier runs of the item: ${result.previous.join(", ")}. The fan-out keeps waiting for ${newRunId}.`
              : `Nothing changed: ${newRunId} already is the current run of item "${result.key}" of run ${result.parentRunId}.`,
            result,
          );
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
      name: "archive_run",
      description:
        "Archive a run that has ended (completed, failed or canceled), exactly like the archive button on its row in the Playbooks panel: it is hidden from the panel and from list_runs (unless archived: true); its state and agents are kept, and restart_run can still reopen it. Use it to clean up after a run is canceled or finished and its job is settled (e.g. after cancel_run, once the human no longer needs it). Refused while the run is active, running, paused or waiting at a gate (cancel_run it first), and while a job it handed to a pipeline is still open at a stage or batch, unless force: true. Archiving twice is fine. Works on any run, like cancel_run.",
      input: z.object({
        runId: IdArg,
        force: z.boolean().default(false).describe("Archive even though a job the run handed to a pipeline is still open (not settled)"),
      }),
      execute: ({ runId, force }) =>
        guard(async () => {
          const { run, already } = await runtime.archiveRunByAgent(runId, force);
          return ok(already ? `Run ${run.id} was already archived.` : `Run ${run.id} archived.`, runListing(run));
        }),
    }),
    defineAgentTool({
      name: "record_followup",
      description:
        "Batches of a singleton pipeline: say what was done for a detached job (handed off: its run was never told how it ends) that a batch settled with an outcome other than the singleton's first (ejected, no_deploy...). The plugin keeps that batch's manager open and reminds it until every such job has a follow-up recorded: either the run you started for it (start_playbook with forJob records it for you), or, with no followUpRunId, an explicit \"none needed\" and a note saying why. More than one may be recorded. Refused for a job that is open, failed, settled with the first outcome, or handed off by a step of an older plugin version that was waiting for its result (that step is told by the plugin). get_run `jobs[].followUps` (pipeline and batch) shows what is recorded, and list_events has job.followup_pending and job.followup. Works from any agent.",
      input: z.object({
        runId: IdArg.describe("The pipeline run, or one of its batches"),
        jobId: z.string().describe("A settled, detached job of the pipeline"),
        followUpRunId: z.string().optional().describe("The run you started for this job (omit when none is needed)"),
        note: z.string().optional().describe("What was done, or why none is needed (required without followUpRunId)"),
      }),
      execute: ({ runId, jobId, followUpRunId, note }, { agent }) =>
        guard(async () => {
          const { pipeline, job } = await runtime.recordFollowUp(jobId, { runId: followUpRunId ?? null, note: note ?? null, by: agent.id }, runId);
          return ok(`Follow-up recorded for job ${jobId}: ${followUpRunId ? `run ${followUpRunId}` : "none needed"}. Follow-ups of the job: ${job.followUps.length}.`, { runId: pipeline.id, jobId, followUps: job.followUps });
        }),
    }),
    defineAgentTool({
      name: "requeue_job",
      description:
        "Put a failed job back on its singleton pipeline, with the same id and inputs (pr_urls, ticket, services, plan...), so the pipeline's next batch carries it: no waiting, nothing is handed off again. Use it for jobs a batch failure took out (e.g. \"manager lost\" past the stage's retries): runId is the pipeline or any of its batches (get_run, list_runs); jobId is a failed job (get_run `jobs` of the pipeline). The job waits at the stages it may enter (those it has not passed) and its failed rides start again. Idempotent: a job that is already open is left as it is (changed: false). Refused for a settled or withdrawn job, a job that passed every stage (its work shipped), a job handed off by a step that waits for its result (that step was told \"failure\"; restart it), and a pipeline that has ended. Emits job.reopened and job.queued (via reopened). Open jobs on a failed batch need no call: the pipeline requeues them by itself when the batch ends. Works on any run, like cancel_run.",
      input: z.object({
        runId: IdArg.describe("The pipeline run, or one of its batches"),
        jobId: z.string().describe("A failed job of the pipeline"),
        reason: z.string().default("").describe("Why, in a sentence (history and the job.reopened event)"),
      }),
      execute: ({ runId, jobId, reason }) =>
        guard(async () => {
          const { pipeline, job, changed } = await runtime.requeueJob(runId, jobId, reason);
          const where = job.waiting.map((entry) => `"${entry.stage}"`).concat(job.batches.map((ride) => `batch ${ride.runId}`)).join(", ") || "no stage";
          return ok(
            changed ? `Job ${jobId} is open again at ${where} of pipeline ${pipeline.id}; its next batch carries it.` : `Job ${jobId} is already open (${where}); nothing changed.`,
            { runId: pipeline.id, jobId, changed, status: job.status, waiting: job.waiting.map((entry) => entry.stage), batches: job.batches.map((ride) => ride.runId) },
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
              `After-task "${taskId}" of run ${run.id} started. Its ready steps: ${engine.readyList(run, engine.readySteps(run)) || "none"}; start only those not marked "starts by itself" with start_step (or request_gate for a gate). For a retro brief, get_run with view "full" gives the whole run.`,
              runChange(run),
            );
          }
          if (run.managerAgentId === "") return ok(`After-task "${taskId}" of run ${run.id} started. The run has no manager (manager.mode: none): the plugin runs it.`, runListing(run));
          return ok(`After-task "${taskId}" of run ${run.id} started. Its manager (agent ${run.managerAgentId}) was woken and runs it.`, runListing(run));
        }),
    }),
    defineAgentTool({
      name: "restart_run",
      description:
        "Recover a finished (completed, failed, canceled, or failed with \"manager lost\") or archived run: reopen it from a step of its main graph whose needs completed. That step and everything after it run again; completed steps before it keep their outputs and are not repeated. With takeOver: true you become its manager (you must be in the run's workspace). Otherwise its manager is woken, or, if that manager was archived, a new Playbook Manager is created in the run's workspace and takes over. If the run's workspace was deleted or has another active run, pass workspaceId to restart it in another workspace of the project. See list_runs (archived: true) for runs, failure and restartableFrom. With model, the restarted step's next attempt runs on it (an agent step only; start_step may still pass another).",
      input: z.object({
        runId: IdArg,
        stepId: z.string().describe("Step to restart from (see restartableFrom in list_runs)"),
        note: z.string().optional().describe("Feedback for the restarted step's next attempt, e.g. what changed since it stopped"),
        workspaceId: z
          .string()
          .optional()
          .describe("Move the run to this workspace (same project, no active run) when its own workspace is gone or has another active run; a new Playbook Manager is created there and completed steps keep their outputs"),
        takeOver: z
          .boolean()
          .default(false)
          .describe("Become the run's manager yourself (you must be an agent of the run's workspace), instead of its previous manager or a new one"),
        ...ModelArgs,
      }),
      execute: ({ runId, stepId, note, takeOver, workspaceId, model, thinking }, { agent }) =>
        guard(async () => {
          // A taker needs the manager tools, which agents get in a workspace with playbooks.
          if (takeOver && runtime.runsOfManager(agent.id).length === 0 && !(await hasPlaybooks(agent.cwd))) {
            throw new UserError("you do not have the manager tools (your workspace has no playbooks): omit takeOver and a Playbook Manager is found for the run");
          }
          const { run, newManager } = await runtime.restartRun(runId, stepId, note?.trim() || null, agent.id, "agent", takeOver ? { id: agent.id, workspaceId: agent.workspaceId } : undefined, workspaceId, modelChoice(model, thinking));
          const isManager = run.managerAgentId === agent.id;
          const next = run.managerAgentId === ""
            ? "The run has no manager (manager.mode: none): the plugin starts the ready steps itself."
            : isManager
            ? `You manage it${newManager ? " now (get_run with view \"full\" shows the completed steps' reports and outputs)" : ""}: ready: ${engine.readyList(run, engine.readySteps(run)) || "none"}; the plugin starts agent steps by itself, start only the others with start_step.`
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
      'Validate the playbooks in <workspace>/.paseo/plugins/playbooks/ and <workspace>/.paseo/playbooks/ (or in the given workspace folder) with the same checks as the Playbooks panel. Writes nothing. Compact by default (results[]: id, valid, errors); view "full" returns every playbook in detail (can exceed the tool-result limit: use playbookId with it).',
    input: z.object({
      path: z.string().optional().describe("Workspace folder to check; defaults to yours"),
      view: PlaybookViewSchema,
      playbookId: z.string().optional().describe("Only this playbook"),
    }),
    execute: ({ path, view, playbookId }, { agent }) =>
      guard(async () => {
        const dir = path ?? agent.cwd;
        const projectId = await runtime.projectIdOf(agent.workspaceId);
        const loaded = await loadPlaybooks(dir, projectId ? { projectId } : {});
        if (!loaded.exists) return ok(`No playbooks folder: create .paseo/plugins/playbooks/ or .paseo/playbooks/ in ${dir}.`, { exists: false, sidekick: { configured: false, errors: [] } });
        // What a new run would load: isolated playbooks come from their fresh base branch, not the checkout.
        const resolved = await resolveForNewRun(dir, loaded);
        const described = describeEntries(resolved.map((item) => item.entry), view, playbookId) as Array<{ id: string; valid: boolean }>;
        const results = described.map((result) => {
          const item = resolved.find((candidate) => candidate.entry.id === result.id)!;
          return { ...result, source: item.source, ...(item.ref ? { ref: item.ref } : {}), ...(item.note ? { note: item.note } : {}) };
        });
        const invalid = results.filter((result) => !result.valid).length;
        const head = loaded.entries.length === 0 ? "No playbook files found." : invalid === 0 ? `All ${results.length} playbook(s) are valid.` : `${invalid} of ${results.length} playbook(s) have errors.`;
        const { sidekick } = loaded;
        const sidekickLine = !sidekick.configured ? "" : sidekick.errors.length === 0 ? `\nSidekick (${sidekick.dir}): valid.` : `\nSidekick (${sidekick.dir}) has errors:\n${sidekick.errors.join("\n")}`;
        return ok(`${head}${sidekickLine}\n${JSON.stringify(results, null, 2)}`, { exists: true, results, sidekick: { configured: sidekick.configured, errors: sidekick.errors } });
      }),
  });
}

export function stepTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "report_step_result",
    description: "Report this playbook step's result. Call exactly once, as your last action. Refused (with the reason) if outputs are missing or mistyped.",
    input: z.object({
      outcome: z.string().describe("One of the outcomes listed in your instructions"),
      // Optional in the schema so a call that lost it gets a specific error rather than a generic one.
      summary: z.string().optional().describe("What you did and found (required)"),
      outputs: z.record(z.string(), VarValueSchema).default({}).describe("Declared outputs by name"),
    }),
    execute: (input, { agent }) =>
      guard(async () => {
        const repaired = repairReport(input, runtime.outcomesOf(agent.id));
        if (!repaired.report) throw new UserError(repaired.error!);
        const stepId = await runtime.report(agent.id, repaired.report, repaired.note);
        return ok(`Report for "${stepId}" recorded${repaired.note ? ` (${repaired.note})` : ""}. Stop here: end your turn.`);
      }),
  });
}

/** For the step agents of a run with no manager: puts the human's answer to a gate's question (asked in their conversation) into the run. */
export function answerGateTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "answer_gate",
    description: "Record the human's answer to the playbook gate you were asked to put to them (with AskUserQuestion). Call it once, right after they answer. If the panel already decided, it says so: end your turn.",
    input: z.object({
      gateId: z.string().describe("The gate id from the message that asked you"),
      decision: z.string().describe("The id of the choice the human picked"),
      comment: z.string().optional().describe("The human's comment, if any"),
    }),
    execute: ({ gateId, decision, comment }, { agent }) => guard(async () => ok(await runtime.answerGateFromChat(agent.id, { gateId, decision, comment: comment ?? null }))),
  });
}

export function gateTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "report_gate_decision",
    description: "Decide the playbook gate you were started for, or leave it to a human. Call exactly once, as your last action.",
    input: z.object({
      decision: z.string().describe('One of the gate\'s choices, or "escalate" to leave it to a human'),
      comment: z.string().describe("Your reason, in one or two sentences"),
    }),
    execute: (input, { agent }) => guard(async () => ok(await runtime.reportGateDecision(agent.id, input))),
  });
}

/** The Sidekick's own tool: saves its decision ledger, and hands the session over to a fresh one when its context is large. */
export function sidekickTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "sidekick_handoff",
    description:
      "Save your short decision ledger and hand-off notes (decisions taken and why, rules applied, subagents and pull requests in flight, open questions, what to check next); the next session of you starts from them. With restart: true, end your turn right after: the plugin replaces you by a new session with this summary, to keep your context small. Only a Sidekick can call it.",
    input: z.object({
      summary: z.string().min(1).max(8000).describe("The ledger and hand-off notes, short and self-contained"),
      restart: z.boolean().default(false).describe("Also restart as a new session when your turn ends"),
    }),
    execute: ({ summary, restart }, { agent }) => guard(async () => ok(await runtime.sidekickHandoff(agent.id, summary, restart))),
  });
}
