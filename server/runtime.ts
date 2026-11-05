import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The daemon API handed to plugin handlers (typed via the SDK, so the build needs no @getpaseo/client). */
type PaseoApi = PluginHandlerContext["paseo"];
import type { Attempt, Playbook, Run, Step, VarValue } from "../shared/types";
import { SCRIPT_NOT_YET, attemptTimeoutMs, isActive, isPaused, isScriptAttempt, isStepLive, isTerminal, restartBlocker, scriptAttemptId } from "../shared/types";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults";
import * as engine from "./engine";
import { checkoutSnapshot, currentRef, snapshotDiff } from "./git";
import { loadPlaybooks } from "./loader";
import { managerAfterRestart, managerKickoff, managerTakeover, reportReminder, resumeAfterRestart, silenceReminder, stepSystemPrompt } from "./prompts";
import type { RunStore } from "./store";
import { holdsBlock, planAdmissions, slotHolders } from "../shared/slots";

export class UserError extends Error {}

/** Plugin tools reach agents through Paseo's MCP server; Claude sees them as mcp__paseo__<name>. */
export const MANAGER_TOOL_NAMES = [
  "list_playbooks",
  "start_playbook",
  "start_step",
  "complete_step",
  "request_gate",
  "resume",
  "nudge_step",
  "get_run",
  "list_runs",
  "cancel_run",
  "restart_run",
  "validate_playbooks",
];
export const STEP_TOOL_NAMES = ["report_step_result"];

type AgentConfig = { provider: string; modeId?: string; thinkingOptionId?: string; options?: { allowedTools: string[] } };

/** Pre-approves our own tools so unattended agents in `default` mode are not blocked on them. */
function preapprove(config: AgentConfig, provider: string, tools: string[]): AgentConfig {
  if (provider === "claude") config.options = { allowedTools: tools.map((tool) => `mcp__paseo__${tool}`) };
  return config;
}

const MANAGER_LABEL = "playbooks/manager";
export const STEP_LABEL = "playbooks/step";
export const RUN_LABEL = "playbooks/run";

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomBytes(3).toString("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Reservation {
  runId: string;
  /** null: the workspace's current branch, read when the run is created. */
  branch: string | null;
  playbook: Playbook;
  inputs: Record<string, VarValue>;
}

/** Kept of a script's output: the end of stdout and stderr, shown in the panel and to the manager. */
const SCRIPT_OUTPUT_MAX = 4000;

/** What a finished script check says, from its exit code and the JSON object on its last stdout line. */
export function scriptResult(
  step: Step,
  exit: { code: number | null; signal: string | null },
  stdout: string,
  stderr: string,
): { outcome: string; summary: string; outputs: Record<string, unknown> } | "not_yet" {
  if (exit.code === SCRIPT_NOT_YET && step.pollMs) return "not_yet";
  const lastLine = stdout.trimEnd().split("\n").at(-1)?.trim() ?? "";
  let result: { outcome?: unknown; summary?: unknown; outputs?: unknown } = {};
  if (lastLine.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(lastLine);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed as typeof result;
    } catch {
      // Not a result line: plain output.
    }
  }
  const summary = typeof result.summary === "string" ? result.summary : null;
  const outputs = result.outputs && typeof result.outputs === "object" && !Array.isArray(result.outputs) ? (result.outputs as Record<string, unknown>) : {};
  if (exit.code === 0) {
    const outcome = typeof result.outcome === "string" ? result.outcome : step.outcomes[0]!;
    return { outcome, summary: summary ?? `${step.script} exited 0`, outputs };
  }
  const why =
    exit.code === SCRIPT_NOT_YET
      ? `exit ${SCRIPT_NOT_YET} ("not yet"), but the step has no \`poll\``
      : exit.code !== null
        ? `exit ${exit.code}`
        : `killed by ${exit.signal ?? "a signal"}`;
  const tail = stderr.trimEnd().split("\n").at(-1)?.trim();
  return { outcome: "failure", summary: summary ?? `${step.script}: ${why}${tail ? `: ${tail}` : ""}`, outputs: {} };
}

/** Environment of a script check: the step's inputs as PLAYBOOK_INPUT_<NAME>, never pasted into a command line. */
function scriptEnv(run: Run, stepId: string, attempt: Run["steps"][string]["attempts"][number], feedback: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYBOOK_RUN_ID: run.id,
    PLAYBOOK_STEP_ID: stepId,
    PLAYBOOK_ATTEMPT: String(attempt.n),
    PLAYBOOK_CHECK: String(attempt.checks + 1),
    PLAYBOOK_WORKSPACE: run.workspaceDir,
  };
  if (feedback) env.PLAYBOOK_FEEDBACK = feedback;
  for (const [name, input] of Object.entries(attempt.inputs)) {
    env[`PLAYBOOK_INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = input.value === "(none)" ? "" : input.value;
  }
  return env;
}

function tailOf(text: string): string {
  return text.length > SCRIPT_OUTPUT_MAX ? text.slice(-SCRIPT_OUTPUT_MAX) : text;
}

/** Last assistant message from a timeline page, for steps that end without reporting. */
function lastAssistantText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index]!.item;
    if (item.type === "assistant_message" && item.text) return item.text.slice(-4000);
  }
  return null;
}

/** Remind a step agent after this long without activity, unless its step sets `silence`. */
export const DEFAULT_SILENCE_MS = 30 * 60_000;

/** How long before a step's timeout its agent gets the silence reminder: a tenth of it, at most 5 min. */
function timeoutLead(timeoutMs: number): number {
  return Math.min(5 * 60_000, Math.floor(timeoutMs / 10));
}

/** When a running agent attempt is due its silence reminder, given its last activity; null when never. */
function silenceDue(step: Step, attempt: Attempt, activeAt: number): number | null {
  const silenceMs = step.silenceMs ?? DEFAULT_SILENCE_MS;
  const candidates: number[] = [];
  if (silenceMs > 0) candidates.push(activeAt + silenceMs);
  const timeoutMs = attemptTimeoutMs(step, attempt);
  if (timeoutMs) candidates.push(Date.parse(attempt.reopenedAt ?? attempt.startedAt) + timeoutMs - timeoutLead(timeoutMs));
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export class Runtime {
  private paseo: PaseoApi | null = null;
  private reconciled: Promise<void> | null = null;
  private readonly busyManagers = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Silence checks of running agent steps, by agent id. */
  private readonly watches = new Map<string, ReturnType<typeof setTimeout>>();
  /** Start reserves a run id and playbook snapshot for the worktree it creates. */
  private readonly reservations = new Map<string, Reservation>();
  /** Runs started from the panel for a busy agent: agent id → run id, delivered when its turn ends. */
  private readonly pendingHandoffs = new Map<string, string>();
  /** Script steps in flight, by attempt id: the running check, or the timer of the next one. */
  private readonly scripts = new Map<string, { child: ChildProcess | null; next: ReturnType<typeof setTimeout> | null }>();
  /** Feedback a script attempt started with (after a goto), passed to each of its checks. */
  private readonly scriptFeedback = new Map<string, string>();

  constructor(private readonly store: RunStore) {}

  // ---------------------------------------------------------------- lifecycle

  /** Every hook, tool and RPC context hands us the daemon API; the first one triggers reconcile. */
  attach(paseo: PaseoApi): Promise<void> {
    this.paseo ??= paseo;
    this.reconciled ??= this.reconcile().catch((error) => console.error("[playbooks] reconcile failed:", error));
    return this.reconciled;
  }

  private api(): PaseoApi {
    if (!this.paseo) throw new Error("Paseo API not attached yet");
    return this.paseo;
  }

  dispose(): void {
    for (const timer of [...this.timers.values(), ...this.watches.values()]) clearTimeout(timer);
    this.timers.clear();
    this.watches.clear();
    for (const id of [...this.scripts.keys()]) this.stopScript(id);
  }

  /**
   * After a (re)start: re-arm timeouts, ask step agents whose turn the restart cut to carry on,
   * treat the ones that cannot as lost, wake idle managers of stalled runs, flush wake-ups.
   */
  private async reconcile(): Promise<void> {
    for (const run of this.store.list()) {
      if (!isActive(run)) continue;
      const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
      if (!manager || manager.agent.archivedAt) {
        await this.failRun(run.id, "manager lost");
        continue;
      }
      if (manager.agent.status === "running") this.busyManagers.add(run.managerAgentId);
      for (const [stepId, state] of Object.entries(run.steps)) {
        if (state.status !== "running") continue;
        const attempt = state.attempts.at(-1)!;
        if (isScriptAttempt(attempt.agentId)) {
          // Checks are idempotent: the one cut by the restart runs again.
          this.armTimeout(run, stepId);
          this.runCheck(run.id, stepId, attempt.agentId);
          continue;
        }
        const agent = await this.api().agents.ref(attempt.agentId).refresh().catch(() => null);
        if (agent?.agent.status === "running") {
          this.armTimeout(run, stepId);
          continue;
        }
        // The restart cut its turn: carry on in the same conversation rather than start over.
        if (agent && !agent.agent.archivedAt && !attempt.report && (await this.resumeStep(run.id, stepId, attempt.agentId))) continue;
        await this.onStepTurnEnded(run.id, attempt.agentId, "lost");
      }
      await this.settleScripts(run.id);
      await this.wakeStalledManager(run.id);
      await this.deliver(run.id);
    }
    await this.admitQueued();
  }

  /** Asks a step agent whose turn a daemon restart cut to carry on. Returns false if it could not be sent. */
  private async resumeStep(runId: string, stepId: string, agentId: string): Promise<boolean> {
    try {
      await this.api().agents.ref(agentId).send(resumeAfterRestart(stepId));
    } catch (error) {
      console.error(`[playbooks] could not resume step "${stepId}" of ${runId}:`, errorText(error));
      return false;
    }
    await this.store.mutate(runId, (current) => engine.markResumed(current, stepId, nowIso()));
    this.armTimeout(this.store.get(runId)!, stepId);
    return true;
  }

  /**
   * A manager whose turn a daemon restart cut may have already read its last wake-up, so nothing
   * would wake it again. When its run waits on it (steps ready or reported, none running, no gate
   * open, no wake-up already queued) and it is idle, queue a note telling it to carry on.
   */
  private async wakeStalledManager(runId: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run || !isActive(run) || isPaused(run) || run.inbox.length > 0 || this.busyManagers.has(run.managerAgentId)) return;
    const steps = Object.entries(run.steps);
    if (steps.some(([, state]) => state.status === "running")) return;
    if (run.gates.some((gate) => gate.status === "pending")) return;
    const withStatus = (status: string) => steps.filter(([, state]) => state.status === status).map(([id]) => id);
    const ready = withStatus("ready");
    const reported = withStatus("reported");
    if (ready.length === 0 && reported.length === 0) return;
    await this.enqueue(runId, [managerAfterRestart(ready, reported)]);
  }

  // ---------------------------------------------------------------- lookups

  allRuns(): Run[] {
    return this.store.list();
  }

  runsOfManager(agentId: string): Run[] {
    return this.store.list().filter((run) => run.managerAgentId === agentId);
  }

  activeRunOfManager(agentId: string): Run | undefined {
    return this.runsOfManager(agentId).find((run) => isActive(run));
  }

  private stepRunOf(agentId: string): { run: Run; stepId: string } | null {
    for (const run of this.store.list()) {
      const found = engine.findAttemptByAgent(run, agentId);
      if (found) return { run, stepId: found.stepId };
    }
    return null;
  }

  /** The run a manager tool refers to; must belong to that manager. */
  ownedRun(managerId: string, runId: string | undefined): Run {
    const run = runId ? this.store.get(runId) : this.activeRunOfManager(managerId) ?? this.runsOfManager(managerId)[0];
    if (!run) throw new UserError(runId ? `unknown run "${runId}"` : "you have no run; call start_playbook first");
    if (run.managerAgentId !== managerId) throw new UserError(`run ${run.id} belongs to another manager`);
    return run;
  }

  // ---------------------------------------------------------------- manager wake-ups

  private async enqueue(runId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    await this.store.mutate(runId, (run) => {
      run.inbox.push(`[playbooks] ${run.id} · ${lines.join(" ")}`);
    });
  }

  /** Sends queued wake-ups to the manager when it is idle, merged into one prompt. A paused run keeps them until resume. */
  async deliver(runId: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run || run.inbox.length === 0 || isPaused(run) || this.busyManagers.has(run.managerAgentId)) return;
    const text = await this.store.mutate(runId, (current) => {
      const merged = current.inbox.join("\n\n");
      current.inbox = [];
      return merged;
    });
    if (!text) return;
    try {
      this.busyManagers.add(run.managerAgentId);
      await this.api().agents.ref(run.managerAgentId).send(text, { activeTurnBehavior: "steer" });
    } catch (error) {
      this.busyManagers.delete(run.managerAgentId);
      console.error(`[playbooks] could not wake manager of ${runId}:`, errorText(error));
      await this.store.mutate(runId, (current) => {
        current.inbox.unshift(text);
      });
    }
  }

  /** Tracked for every agent: a manager's first turn starts before its run exists. */
  /** The manager just read the full run state: queued wake-ups are stale. */
  async clearInbox(runId: string): Promise<void> {
    if ((this.store.get(runId)?.inbox.length ?? 0) === 0) return;
    await this.store.mutate(runId, (run) => {
      run.inbox = [];
    });
  }

  onTurnStarted(agentId: string): void {
    this.busyManagers.add(agentId);
  }

  async onManagerTurnEnded(agentId: string): Promise<void> {
    this.busyManagers.delete(agentId);
    for (const run of this.runsOfManager(agentId)) await this.deliver(run.id);
  }

  private async applyEffects(runId: string, effects: engine.Effects): Promise<void> {
    for (const agentId of effects.cancelAgents) {
      this.clearTimeout(agentId);
      // Archiving stops it too.
      if (effects.archiveAgents.includes(agentId)) continue;
      if (isScriptAttempt(agentId)) {
        this.stopScript(agentId);
        continue;
      }
      await this.api()
        .agents.ref(agentId)
        .reload()
        .catch((error) => console.error(`[playbooks] could not stop agent ${agentId}:`, errorText(error)));
    }
    for (const agentId of effects.archiveAgents) await this.archiveStepAgent(agentId);
  }

  /** Archives a step agent the run no longer needs, which ends its session; already archived is fine. */
  private async archiveStepAgent(agentId: string): Promise<void> {
    const agent = this.api().agents.ref(agentId);
    try {
      const current = await agent.refresh();
      if (!current || current.agent.archivedAt) return;
      await agent.archive();
    } catch (error) {
      console.error(`[playbooks] could not archive agent ${agentId}:`, errorText(error));
    }
  }

  // ---------------------------------------------------------------- manager tools

  async startPlaybook(
    manager: { id: string; workspaceId: string | null; cwd: string },
    playbookId: string,
    inputs: Record<string, unknown>,
    preloaded?: Playbook,
  ): Promise<Run> {
    if (!manager.workspaceId) throw new UserError("this agent has no workspace");
    const workspace = await this.api().workspaces.ref(manager.workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    const active = this.store.list().find((run) => run.workspaceId === workspace.id && isActive(run));
    if (active) throw new UserError(`this workspace already has an active run (${active.id}); one active run per workspace`);
    const workspaceDir = workspace.workspaceDirectory ?? manager.cwd;
    const reservation = this.reservations.get(workspace.id);
    let playbook: Playbook | null = preloaded ?? (reservation && reservation.playbook.id === playbookId ? reservation.playbook : null);
    if (!playbook) {
      const loaded = await loadPlaybooks(workspaceDir);
      const entry = loaded.entries.find((candidate) => candidate.id === playbookId);
      if (!entry) throw new UserError(`no playbook "${playbookId}" in this workspace (have: ${loaded.entries.map((e) => e.id).join(", ") || "none"})`);
      if (!entry.playbook) throw new UserError(`playbook "${playbookId}" is invalid:\n${entry.errors.join("\n")}`);
      playbook = entry.playbook;
    }
    this.checkConcurrency(playbook, workspace.projectId);
    const run = engine.newRun({
      id: reservation?.runId ?? `run_${shortId()}`,
      playbook,
      workspaceId: workspace.id,
      workspaceDir,
      projectId: workspace.projectId,
      branch: reservation?.branch ?? (await currentRef(workspaceDir)),
      managerAgentId: manager.id,
      inputs,
      now: nowIso(),
    });
    await this.store.create(run);
    this.reservations.delete(workspace.id);
    await this.admitQueued(run.id);
    return this.store.get(run.id)!;
  }

  /** Slots are shared: active runs of the playbook, and blocks of it that other runs hold. */
  private checkConcurrency(playbook: Playbook, projectId: string): void {
    if (playbook.concurrency === undefined) return;
    const holders = slotHolders(this.store.list(), projectId, playbook.id);
    if (holders.length >= playbook.concurrency) {
      throw new UserError(
        `playbook "${playbook.id}" allows ${playbook.concurrency} active run(s) in this project; active: ${holders.join(", ")}`,
      );
    }
  }

  /**
   * Starts the blocks that were waiting for a `concurrency` slot and can enter now, oldest
   * first. Called wherever a run may have released a slot. The caller's own run is not
   * announced: its manager reads the result of the call.
   */
  private async admitQueued(callerRunId?: string): Promise<void> {
    for (const { runId, prefix } of planAdmissions(this.store.list())) {
      const admitted = await this.store.mutate(runId, (run) => engine.admitBlock(run, prefix, nowIso()));
      if (admitted.length === 0 || runId === callerRunId) continue;
      const run = this.store.get(runId)!;
      const toStart = admitted.filter((id) => engine.stepDef(run, id).kind !== "script");
      if (toStart.length === 0) continue;
      await this.enqueue(runId, [`A concurrency slot is free: ${toStart.join(", ")} ${toStart.length === 1 ? "is" : "are"} now ready. Start ${toStart.length === 1 ? "it" : "them"} with start_step.`]);
      await this.deliver(runId);
    }
    // Every place that may make steps ready ends here, so ready script steps start here too.
    await this.startScripts();
  }

  // ---------------------------------------------------------------- script steps

  /** Starts the ready script steps of every active, unpaused run: the plugin runs them, not the manager. */
  private async startScripts(): Promise<void> {
    for (const run of this.store.list()) {
      if (!isActive(run) || isPaused(run)) continue;
      for (const stepId of engine.readyScripts(run)) {
        const started = await this.store.mutate(run.id, (current) => {
          if (current.steps[stepId]!.status !== "ready" || isPaused(current)) return null;
          const feedback = current.steps[stepId]!.feedback;
          const id = scriptAttemptId(current.id, stepId, current.steps[stepId]!.attempts.length + 1);
          engine.startAttempt(current, stepId, { agentId: id, brief: "", now: nowIso(), readonlySnapshot: null });
          return { id, feedback };
        });
        if (!started) continue;
        if (started.feedback) this.scriptFeedback.set(started.id, started.feedback);
        this.armTimeout(this.store.get(run.id)!, stepId);
        this.runCheck(run.id, stepId, started.id);
      }
    }
  }

  /** Runs the script once in the run's worktree. "Not yet" schedules the next check; anything else ends the attempt. */
  private runCheck(runId: string, stepId: string, attemptId: string): void {
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || attempt?.agentId !== attemptId || run.steps[stepId]!.status !== "running") return;
    const step = engine.stepDef(run, stepId);
    const slot = { child: null as ChildProcess | null, next: null as ReturnType<typeof setTimeout> | null };
    this.scripts.set(attemptId, slot);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (exit: { code: number | null; signal: string | null }, spawnError?: string) => {
      if (settled) return;
      settled = true;
      slot.child = null;
      // Stopped (canceled, reset by a goto, timed out): whoever stopped it owns the attempt now.
      if (this.scripts.get(attemptId) !== slot) return;
      const result = spawnError
        ? { outcome: "failure", summary: `${step.script}: ${spawnError}`, outputs: {} }
        : scriptResult(step, exit, stdout, stderr);
      void this.onCheckEnded(runId, stepId, attemptId, result, tailOf([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")));
    };
    try {
      const child = spawn(path.join(run.workspaceDir, step.script!), [], {
        cwd: run.workspaceDir,
        env: scriptEnv(run, stepId, attempt, this.scriptFeedback.get(attemptId) ?? null),
        stdio: ["ignore", "pipe", "pipe"],
      });
      slot.child = child;
      child.stdout!.on("data", (chunk: Buffer) => (stdout = tailOf(stdout + chunk.toString())));
      child.stderr!.on("data", (chunk: Buffer) => (stderr = tailOf(stderr + chunk.toString())));
      child.on("error", (error) => done({ code: null, signal: null }, errorText(error)));
      child.on("close", (code, signal) => done({ code, signal }));
    } catch (error) {
      done({ code: null, signal: null }, errorText(error));
    }
  }

  private async onCheckEnded(
    runId: string,
    stepId: string,
    attemptId: string,
    result: ReturnType<typeof scriptResult>,
    output: string,
  ): Promise<void> {
    const run = this.store.get(runId);
    if (!run) return this.stopScript(attemptId);
    const step = engine.stepDef(run, stepId);
    const nextAt = result === "not_yet" ? new Date(Date.now() + step.pollMs!).toISOString() : null;
    const current = await this.store.mutate(runId, (run) => {
      const attempt = run.steps[stepId]?.attempts.at(-1);
      if (attempt?.agentId !== attemptId || run.steps[stepId]!.status !== "running") return false;
      attempt.checks += 1;
      attempt.nextCheckAt = nextAt;
      attempt.lastMessage = output || null;
      return true;
    });
    if (!current) return this.stopScript(attemptId);
    if (result === "not_yet") {
      const slot = this.scripts.get(attemptId);
      if (!slot) return;
      slot.next = setTimeout(() => this.runCheck(runId, stepId, attemptId), step.pollMs!);
      (slot.next as unknown as { unref?: () => void }).unref?.();
      return;
    }
    await this.finishScript(runId, stepId, attemptId, result, "completed");
  }

  /** Records a script attempt's result and ends it; the step completes now, or on resume if the run is paused. */
  private async finishScript(
    runId: string,
    stepId: string,
    attemptId: string,
    result: { outcome: string; summary: string; outputs: Record<string, unknown> },
    turnEnd: "completed" | "timeout" | "lost",
  ): Promise<void> {
    this.stopScript(attemptId);
    this.clearTimeout(attemptId);
    await this.store.mutate(runId, (run) => {
      const attempt = run.steps[stepId]?.attempts.at(-1);
      if (attempt?.agentId !== attemptId || run.steps[stepId]!.status !== "running") return;
      attempt.nextCheckAt = null;
      try {
        engine.recordReport(run, attemptId, result, nowIso());
      } catch (error) {
        // A bad outcome or outputs line is the script's failure, not a reason to hang.
        engine.recordReport(run, attemptId, { outcome: "failure", summary: `${result.summary} (result refused: ${errorText(error)})`, outputs: {} }, nowIso());
      }
      engine.endTurn(run, attemptId, { turnEnd, lastMessage: attempt.lastMessage, now: nowIso() });
    });
    await this.settleScripts(runId);
  }

  /** Completes script steps that reported (with the reported outcome) and wakes the manager with what follows. Waits while paused. */
  private async settleScripts(runId: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run || isPaused(run)) return;
    for (const step of run.playbook.steps) {
      const state = this.store.get(runId)!.steps[step.id]!;
      if (step.kind !== "script" || state.status !== "reported" || !isStepLive(this.store.get(runId)!, step.id)) continue;
      const attempt = state.attempts.at(-1)!;
      const report = attempt.report ?? { outcome: "failure", summary: `${step.script} ended without a result`, outputs: {} };
      let effects: engine.Effects;
      try {
        effects = await this.store.mutate(runId, (current) =>
          engine.completeStep(current, step.id, { outcome: report.outcome, summary: report.summary, outputs: report.outputs, now: nowIso() }),
        );
      } catch (error) {
        // Left reported: the manager decides with complete_step.
        await this.enqueue(runId, [`script step "${step.id}" attempt ${attempt.n} ended ${report.outcome} but could not be completed (${errorText(error)}). Call complete_step for it.`]);
        continue;
      }
      await this.applyEffects(runId, effects);
      await this.admitQueued();
      const after = this.store.get(runId)!;
      // A failure with retries left: the script already runs again, nothing for the manager yet.
      const again = after.steps[step.id]!;
      if ((again.status === "running" || again.status === "ready") && again.attempts.length > state.attempts.length) continue;
      const ready = engine.readySteps(after);
      await this.enqueue(runId, [
        `script step "${step.id}" attempt ${attempt.n} ended ${report.outcome} after ${attempt.checks} check(s): ${report.summary}${Object.keys(report.outputs).length ? ` Outputs: ${JSON.stringify(report.outputs)}.` : ""}`,
        "The plugin completed it; do not call complete_step for it.",
        ...effects.notes,
        isActive(after) && ready.length > 0 ? `Ready: ${ready.join(", ")}. Start them with start_step (or request_gate for a gate).` : "",
        isTerminal(after.status) && !isActive(after) ? `The run is ${after.status}. Tell the human.` : "",
      ].filter(Boolean));
    }
    await this.deliver(runId);
  }

  /** Kills a script's running check and drops its next one. */
  private stopScript(attemptId: string): void {
    const slot = this.scripts.get(attemptId);
    this.scripts.delete(attemptId);
    this.scriptFeedback.delete(attemptId);
    if (!slot) return;
    if (slot.next) clearTimeout(slot.next);
    slot.child?.kill("SIGTERM");
  }

  async startStep(managerId: string, runId: string, stepId: string, brief: string): Promise<{ agentId: string; attempt: number }> {
    const run = this.ownedRun(managerId, runId);
    const step = engine.stepDef(run, stepId);
    if (step.kind === "script") throw new UserError(`step "${stepId}" is a script step: the plugin runs it by itself and wakes you with its result`);
    if (step.kind !== "agent" || !step.role) throw new UserError(`step "${stepId}" is a gate; call request_gate`);
    if (run.steps[stepId]!.status !== "ready") {
      throw new UserError(`step "${stepId}" is ${run.steps[stepId]!.status}, not ready (ready now: ${engine.readySteps(run).join(", ") || "none"})`);
    }
    const role = run.playbook.roles[step.role]!;
    const config = await this.stepAgentConfig(run, step);
    const snapshot = role.readonly ? await checkoutSnapshot(run.workspaceDir) : null;
    const attemptNo = run.steps[stepId]!.attempts.length + 1;
    const previous = run.steps[stepId]!.attempts.at(-1);
    const agent = await this.api()
      .workspaces.ref(run.workspaceId)
      .agents.create({
        config: { ...config, systemPrompt: stepSystemPrompt(run.playbook, step, role) },
        parent: managerId,
        title: `${run.playbook.title} · ${role.title} #${attemptNo}`,
        labels: { [RUN_LABEL]: run.id, [STEP_LABEL]: stepId, "playbooks/attempt": String(attemptNo) },
      });
    const started = await this.store.mutate(run.id, (current) =>
      engine.startAttempt(current, stepId, { agentId: agent.id, brief, now: nowIso(), readonlySnapshot: snapshot }),
    );
    await agent.send(started.prompt);
    this.armTimeout(this.store.get(run.id)!, stepId);
    // The previous attempt's agent is done: the step's history keeps its outcome.
    if (previous && step.archiveAgents !== false) await this.archiveStepAgent(previous.agentId);
    return { agentId: agent.id, attempt: started.attempt.n };
  }

  private async stepAgentConfig(run: Run, step: Step) {
    const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    const provider = step.agent.provider ?? manager?.agent.provider ?? DEFAULT_PROVIDER;
    const model =
      step.agent.model ?? (manager?.agent.provider === provider ? manager?.agent.model ?? undefined : undefined) ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
    if (!model) throw new UserError(`step "${step.id}": no model for provider "${provider}"; set agent.model in the playbook`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (step.agent.mode) config.modeId = step.agent.mode;
    if (step.agent.thinking) config.thinkingOptionId = step.agent.thinking;
    return preapprove(config, provider, STEP_TOOL_NAMES);
  }

  async completeStep(managerId: string, runId: string, stepId: string, input: { outcome: string; summary?: string; outputs?: Record<string, unknown> }): Promise<Run> {
    const run = this.ownedRun(managerId, runId);
    const effects = await this.store.mutate(run.id, (current) => {
      const args: Parameters<typeof engine.completeStep>[2] = { outcome: input.outcome, now: nowIso() };
      if (input.summary !== undefined) args.summary = input.summary;
      if (input.outputs !== undefined) args.outputs = input.outputs;
      return engine.completeStep(current, stepId, args);
    });
    await this.applyEffects(run.id, effects);
    await this.admitQueued(run.id);
    return this.store.get(run.id)!;
  }

  async requestGate(managerId: string, runId: string, stepId: string, summary: string, details: string) {
    const run = this.ownedRun(managerId, runId);
    return this.store.mutate(run.id, (current) => engine.requestGate(current, stepId, summary, nowIso(), details));
  }

  /** A gate decision from the panel (wakes the manager) or from chat via resume (does not). */
  async decideGate(runId: string, gateId: string, decision: engine.GateDecision): Promise<{ alreadyDecided: boolean; gate: Run["gates"][number] }> {
    const result = await this.store.mutate(runId, (current) => engine.decideGate(current, gateId, decision));
    await this.applyEffects(runId, result.effects);
    await this.admitQueued(runId);
    if (!result.alreadyDecided && decision.via === "panel") {
      const run = this.store.get(runId)!;
      await this.dismissQuestions(run.managerAgentId, `The human decided gate ${result.gate.id} in the Playbooks panel instead: ${decision.decision}. Do not call resume. End your turn; you are woken with what comes next.`);
      const comment = decision.comment ? `: "${decision.comment}"` : "";
      await this.enqueue(runId, [
        `Gate ${result.gate.stepId} ${decision.decision} by ${decision.by ?? "a human"} via panel${comment}.`,
        ...result.effects.notes,
        run.status === "running" ? `Ready: ${engine.readySteps(run).join(", ") || "none"}.` : "",
      ].filter(Boolean));
      await this.deliver(runId);
    }
    return { alreadyDecided: result.alreadyDecided, gate: result.gate };
  }

  /**
   * Answers the manager's open questions (asked in chat for a gate) once the panel made them
   * moot: its turn is blocked on them, so the queued wake-up could not reach it otherwise.
   */
  private async dismissQuestions(managerId: string, message: string): Promise<void> {
    const manager = this.api().agents.ref(managerId);
    const current = await manager.refresh().catch(() => null);
    for (const request of current?.agent.pendingPermissions ?? []) {
      if (request.kind !== "question") continue;
      await manager
        .respondToPermission({ requestId: request.id, response: { behavior: "deny", message } })
        .catch((error) => console.error(`[playbooks] could not dismiss the question of manager ${managerId}:`, errorText(error)));
    }
  }

  /** Hides a finished run from the panel; nothing else changes (no agent is archived or stopped). */
  async archiveRun(runId: string): Promise<string> {
    return this.store.mutate(runId, (run) => {
      if (!isTerminal(run.status)) throw new UserError(`run ${runId} is ${run.status}: cancel it before archiving`);
      if (isActive(run)) throw new UserError(`run ${runId} is wrapping up (after-tasks running): wait or cancel them before archiving`);
      run.archivedAt ??= nowIso();
      return run.archivedAt;
    });
  }

  /** Marks a finished run as seen by a human; an active run stays unseen (it can still change). */
  async markSeen(runId: string): Promise<string | null> {
    return this.store.mutate(runId, (run) => {
      if (!isActive(run)) run.seenAt ??= nowIso();
      return run.seenAt;
    });
  }

  /** `by` (e.g. "from the panel") tells the manager who canceled; null when the manager did it or is gone. */
  async cancelRun(runId: string, reason: string, by: string | null): Promise<Run> {
    const effects = await this.store.mutate(runId, (current) => engine.cancelRun(current, reason, nowIso()));
    await this.applyEffects(runId, effects);
    await this.admitQueued(runId);
    if (by) {
      const status = this.store.get(runId)!.status;
      await this.dismissQuestions(this.store.get(runId)!.managerAgentId, `The run was canceled ${by}. End your turn.`);
      await this.enqueue(runId, [
        status === "canceled"
          ? `The run was canceled ${by}: ${reason}. Tell the human and stop.`
          : `The after-tasks were canceled ${by}: ${reason}. The run stays ${status}. Tell the human and stop.`,
      ]);
      await this.deliver(runId);
    }
    return this.store.get(runId)!;
  }

  /**
   * Pauses the run from the panel (drain). Running steps finish their turn; their reports wait.
   * A manager in the middle of a turn is told, so it stops starting steps; an idle one is left alone.
   */
  async pauseRun(runId: string): Promise<Run> {
    const changed = await this.store.mutate(runId, (current) => engine.pauseRun(current, nowIso()));
    const run = this.store.get(runId)!;
    if (changed && this.busyManagers.has(run.managerAgentId)) {
      await this.api()
        .agents.ref(run.managerAgentId)
        .send(
          `[playbooks] ${run.id} · A human paused the run from the panel. start_step is refused until they resume it; running steps finish their current turn and their reports reach you on resume. Do not start steps: finish what you are doing and end your turn.`,
          { activeTurnBehavior: "steer" },
        )
        .catch((error) => console.error(`[playbooks] could not tell the manager of ${runId} about the pause:`, errorText(error)));
    }
    return run;
  }

  /** Lifts the pause and wakes the manager with everything that queued up meanwhile. */
  async resumeRun(runId: string): Promise<Run> {
    const changed = await this.store.mutate(runId, (current) => engine.resumeRun(current, nowIso()));
    // Slots freed while paused went to other runs; this run may take one now.
    await this.admitQueued();
    // Script steps that finished during the pause complete now; their wake-ups join the others.
    await this.settleScripts(runId);
    if (changed) {
      const run = this.store.get(runId)!;
      const ready = engine.readySteps(run);
      await this.enqueue(runId, [
        `A human resumed the run from the panel.`,
        run.inbox.length > 0 ? "What happened while it was paused follows." : "",
        isTerminal(run.status) ? "" : `Ready: ${ready.join(", ") || "none"}.${ready.length ? " Start them with start_step." : ""}`,
      ].filter(Boolean));
      // The resume note goes first, then the wake-ups held during the pause.
      await this.store.mutate(runId, (current) => {
        const note = current.inbox.pop();
        if (note) current.inbox.unshift(note);
      });
      await this.deliver(runId);
    }
    return this.store.get(runId)!;
  }

  private async failRun(runId: string, reason: string): Promise<void> {
    const effects = await this.store.mutate(runId, (current) => engine.failRun(current, reason, nowIso()));
    await this.applyEffects(runId, effects);
    await this.admitQueued(runId);
  }

  /** Sends a follow-up to the current attempt's agent, in the same conversation. While paused, only a human may. */
  async nudgeStep(runId: string, stepId: string, message: string, byHuman = false): Promise<void> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    if (!byHuman && isPaused(run)) throw new UserError(`run ${run.id} is paused by a human: wait until it is resumed. End your turn.`);
    const state = run.steps[stepId];
    const attempt = state?.attempts.at(-1);
    if (!state || !attempt) throw new UserError(`step "${stepId}" has no attempt to nudge`);
    if (isScriptAttempt(attempt.agentId)) throw new UserError(`step "${stepId}" is a script step: there is no agent to nudge`);
    if (!isStepLive(run, stepId)) throw new UserError(`step "${stepId}" can no longer change: run ${run.id} is ${run.status}`);
    if (state.status === "reported") {
      // The agent works again: its next turn end reports again (after a timeout, its report replaces the timeout failure).
      await this.store.mutate(runId, (current) => engine.reopenAttempt(current, stepId, nowIso()));
      this.armTimeout(this.store.get(runId)!, stepId);
    } else if (state.status !== "running") {
      throw new UserError(`step "${stepId}" is ${state.status}; only a running or reported step can be nudged`);
    }
    await this.api().agents.ref(attempt.agentId).send(message, { activeTurnBehavior: "steer" });
  }

  /**
   * Starts a manual after-task, from the panel or, when the human asks in chat, the
   * start_after_task tool (`by` is that agent). The manager is woken to run it, unless it
   * is the caller: it reads the ready steps in the tool result.
   */
  async startAfterTask(runId: string, taskId: string, by: string | null = null): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    if (!manager || manager.agent.archivedAt) throw new UserError("this run's Playbook Manager no longer exists");
    const busy = this.store.list().find((other) => other.id !== run.id && other.workspaceId === run.workspaceId && isActive(other));
    if (busy) throw new UserError(`this workspace has another active run (${busy.id}); wait for it to end`);
    const effects = await this.store.mutate(runId, (current) => engine.startAfterTask(current, taskId, nowIso()));
    if (by === run.managerAgentId) return this.store.get(runId)!;
    const who = by ? `Agent ${by} started the after-task "${taskId}" at the human's request.` : `A human started the after-task "${taskId}" from the panel.`;
    await this.enqueue(runId, [who, ...effects.notes]);
    await this.deliver(runId);
    return this.store.get(runId)!;
  }

  /**
   * Reopens a finished (or archived) run from a step, from the panel or the restart_run tool.
   * Same workspace and branch. With `takeOver`, that agent (the restart_run caller, in the
   * run's workspace) becomes the manager. Otherwise the manager stays when it still exists,
   * and a new Playbook Manager is created in the run's workspace when it does not. Refused
   * when the workspace has another active run or a concurrency slot the restarted run would
   * hold is taken.
   */
  async restartRun(
    runId: string,
    stepId: string,
    comment: string | null,
    by: string | null,
    via: "panel" | "agent" = "panel",
    takeOver?: { id: string; workspaceId: string | null },
  ): Promise<{ run: Run; newManager: boolean }> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    const blocker = restartBlocker(run, stepId);
    if (blocker) throw new UserError(blocker);
    if (takeOver && takeOver.workspaceId !== run.workspaceId) {
      throw new UserError(`run ${run.id} is in another workspace (${run.workspaceId}, ${run.workspaceDir}): only an agent of that workspace can take it over; omit takeOver and a manager is found for it`);
    }
    const busy = this.store.list().find((other) => other.id !== run.id && other.workspaceId === run.workspaceId && isActive(other));
    if (busy) throw new UserError(`this workspace has another active run (${busy.id}); one active run per workspace`);
    // Dry run: the restarted run must fit in the concurrency slots it would hold.
    const trial = structuredClone(run);
    engine.restartRun(trial, stepId, { comment, by, now: nowIso() });
    const runs = [...this.store.list().filter((other) => other.id !== run.id), trial];
    const limits: Array<[string, number]> = [];
    if (trial.playbook.concurrency !== undefined) limits.push([trial.playbook.id, trial.playbook.concurrency]);
    for (const [prefix, block] of Object.entries(trial.playbook.blocks)) {
      if (block.concurrency !== undefined && holdsBlock(trial, prefix)) limits.push([block.playbook, block.concurrency]);
    }
    for (const [playbookId, limit] of limits) {
      const holders = slotHolders(runs, run.projectId, playbookId);
      if (holders.length > limit) {
        throw new UserError(`"${playbookId}" allows ${limit} active run(s) in this project; held by: ${holders.filter((id) => !id.startsWith(run.id)).join(", ")}. Try again once one ends.`);
      }
    }
    const manager = takeOver ? null : await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    const managerGone = !takeOver && (!manager || Boolean(manager.agent.archivedAt));
    // The original manager was archived (which also archives its runs): a new one takes over.
    // It is created without a prompt, so it cannot look for the run before the run is its own.
    const replacement = managerGone ? await this.createReplacementManager(run) : null;
    const effects = await this.store.mutate(runId, (current) => {
      const fx = engine.restartRun(current, stepId, { comment, by, now: nowIso() });
      if (replacement) current.managerAgentId = replacement.id;
      if (takeOver) current.managerAgentId = takeOver.id;
      return fx;
    });
    await this.admitQueued(runId);
    const ready = engine.readySteps(this.store.get(runId)!);
    const who = via === "panel" ? `A human${by ? ` (${by})` : ""} restarted the run from "${stepId}" via the panel` : `Agent ${by ?? "(unknown)"} restarted the run from "${stepId}"`;
    const lines = [
      `${who}${comment ? `: "${comment}"` : ""}.`,
      ...effects.notes,
      `Completed steps before it keep their outputs (get_run shows them). Carry on as usual: start ${ready.length === 1 ? "the ready step" : "the ready steps"} with start_step (or request_gate for a gate).`,
    ];
    if (takeOver) {
      // The caller reads the ready steps in the tool result; nothing to wake.
    } else if (replacement) {
      const current = this.store.get(runId)!;
      await replacement.send(`${managerTakeover(current, ready, "restarted after its previous manager was archived")}\n\n[playbooks] ${lines.join(" ")}`);
    } else {
      await this.enqueue(runId, lines);
      await this.deliver(runId);
    }
    return { run: this.store.get(runId)!, newManager: replacement !== null || (takeOver !== undefined && takeOver.id !== run.managerAgentId) };
  }

  /** A new Playbook Manager in the run's workspace, created without a prompt so it cannot look for the run before the run is its own. */
  private async createReplacementManager(run: Run) {
    return this.api()
      .workspaces.ref(run.workspaceId)
      .agents.create({
        config: this.managerConfig(run.playbook),
        title: `Playbook Manager · ${run.playbook.title}`,
        labels: { [MANAGER_LABEL]: "true" },
      })
      .catch((error: unknown) => {
        throw new UserError(`could not create a new Playbook Manager in the run's workspace: ${errorText(error)}`);
      });
  }

  /**
   * Paseo archives an agent's children with it, so archiving a Coordinator that created the
   * manager (create_agent) also archives the manager and its step agents. That was not a
   * decision about the run: a new Playbook Manager takes the active run over instead of it
   * failing. Steps whose agents went with it end as lost; the new manager retries them.
   */
  private async adoptOrphanedRun(runId: string, parentId: string): Promise<boolean> {
    const run = this.store.get(runId)!;
    const replacement = await this.createReplacementManager(run).catch((error: unknown) => {
      console.error(`[playbooks] could not hand run ${runId} to a new manager:`, errorText(error));
      return null;
    });
    if (!replacement) return false;
    const previous = run.managerAgentId;
    await this.store.mutate(runId, (working) =>
      engine.replaceManager(working, replacement.id, `archived with its parent ${parentId}`, nowIso()),
    );
    const current = this.store.get(runId)!;
    this.busyManagers.delete(previous);
    const withStatus = (status: string) => Object.entries(current.steps).filter(([, state]) => state.status === status).map(([id]) => id);
    const running = withStatus("running");
    // Steps archived before their manager already ended; their wake-up may have gone to the old manager.
    const reported = withStatus("reported");
    const note = [
      `[playbooks] ${current.id} · The previous manager (agent ${previous}) was archived because the agent that created it (${parentId}) was archived. You take the run over from where it is: completed steps keep their outputs (get_run shows them).`,
      running.length > 0
        ? `Steps that were running had their agents archived too: ${running.join(", ")}. When they show as ended (lost), call complete_step with "failure" to start them again (a lost attempt does not count as a retry), unless their report or the worktree shows the work is done.`
        : "",
      reported.length > 0
        ? `Steps waiting for complete_step: ${reported.join(", ")}. Read them with get_run; a step that ended (lost) without a report had its agent archived: complete it with "failure" to start it again, unless the work is done.`
        : "",
      current.status === "waiting_gate" ? "A gate is waiting for a human decision: ask them again (see get_run)." : "",
    ].filter(Boolean);
    await replacement.send(`${managerTakeover(current, engine.readySteps(current), "after its previous manager was archived with its parent")}\n\n${note.join(" ")}`);
    await this.deliver(runId);
    return true;
  }

  async askManagerToRetry(runId: string, stepId: string): Promise<void> {
    const run = this.store.get(runId);
    if (run && isPaused(run)) throw new UserError(`run ${runId} is paused: resume it first`);
    await this.enqueue(runId, [`A human asked to retry step "${stepId}" from the panel. Check get_run and start it again if it is ready, or complete it with "failure" first so it becomes ready.`]);
    await this.deliver(runId);
  }

  // ---------------------------------------------------------------- step agents

  async report(agentId: string, report: { outcome: string; summary: string; outputs: Record<string, unknown> }): Promise<string> {
    const found = this.stepRunOf(agentId);
    if (!found) throw new UserError("you are not the current attempt of any playbook step");
    await this.store.mutate(found.run.id, (current) => engine.recordReport(current, agentId, report, nowIso()));
    return found.stepId;
  }

  async onStepTurnEnded(runId: string, agentId: string, turnEnd: "completed" | "failed" | "canceled" | "lost" | "timeout"): Promise<void> {
    const run = this.store.get(runId);
    if (!run) return;
    const found = engine.findAttemptByAgent(run, agentId);
    if (!found || run.steps[found.stepId]!.status !== "running") return;
    this.clearTimeout(agentId);
    let lastMessage: string | null = null;
    if (!found.attempt.report) {
      const page = await this.api().agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30 }).catch(() => null);
      lastMessage = page ? lastAssistantText(page.entries as never) : null;
      if (turnEnd === "completed" && !found.attempt.reminded && !isPaused(run) && (await this.remindToReport(runId, found.stepId, agentId))) return;
    }
    const violation =
      found.attempt.readonlySnapshot !== null ? snapshotDiff(found.attempt.readonlySnapshot, await checkoutSnapshot(run.workspaceDir)) : null;
    const ended = await this.store.mutate(runId, (current) => {
      const result = engine.endTurn(current, agentId, { turnEnd, lastMessage, now: nowIso() });
      if (result && violation) engine.markReadonlyViolation(current, result.stepId, violation, nowIso());
      return result;
    });
    if (!ended) return;
    const report = this.store.get(runId)!.steps[ended.stepId]!.attempts.at(-1)!.report;
    const head = `step "${ended.stepId}" attempt ${ended.attempt.n}`;
    const line = report
      ? `${head} reported ${report.outcome}: ${report.summary}${Object.keys(report.outputs).length ? ` Outputs: ${JSON.stringify(report.outputs)}.` : ""}${turnEnd === "timeout" ? " If its work is in fact done, nudge_step it to report: its report replaces the timeout failure. Or call complete_step with the outputs from its conversation." : ""}`
      : ended.attempt.reminded
        ? `${head} ended (${turnEnd}) without reporting, even after the plugin asked it to.${lastMessage ? ` Last message: ${lastMessage.slice(0, 1500)}` : ""} If it is still waiting on something, nudge_step it later. If it could not report (e.g. report_step_result "not found"), check the outputs it gave in its conversation and call complete_step with them.`
        : `${head} ended (${turnEnd}) without reporting.${lastMessage ? ` Last message: ${lastMessage.slice(0, 1500)}` : ""} Use nudge_step to ask it to report, or complete_step.`;
    const others = Object.entries(this.store.get(runId)!.steps)
      .filter(([, state]) => state.status === "running")
      .map(([id]) => id);
    await this.enqueue(runId, [
      line,
      violation ? `Readonly check failed (${violation}); complete it with "failure".` : "",
      `Call complete_step for "${ended.stepId}".`,
      others.length > 0 ? `Still running: ${others.join(", ")}.` : "",
    ].filter(Boolean));
    await this.deliver(runId);
  }

  /**
   * A step's turn completed without a report: ask the agent once, in the same conversation, before
   * waking the manager. Paseo binds plugin tools to the plugin instance a session opened with, so a
   * plugin reload during a long turn makes report_step_result "not found" until the agent's next
   * prompt reopens the session; this prompt is that reopening. Returns false if it could not be sent.
   */
  private async remindToReport(runId: string, stepId: string, agentId: string): Promise<boolean> {
    await this.store.mutate(runId, (current) => {
      current.steps[stepId]!.attempts.at(-1)!.reminded = true;
    });
    try {
      await this.api().agents.ref(agentId).send(reportReminder(stepId));
    } catch (error) {
      console.error(`[playbooks] could not remind step "${stepId}" of ${runId} to report:`, errorText(error));
      return false;
    }
    this.armTimeout(this.store.get(runId)!, stepId);
    return true;
  }

  /** Lifecycle hook: any agent's turn ended. */
  async onTurnEnded(agentId: string, outcome: "completed" | "failed" | "canceled"): Promise<void> {
    const step = this.stepRunOf(agentId);
    if (step) await this.onStepTurnEnded(step.run.id, agentId, outcome);
    const handoff = this.pendingHandoffs.get(agentId);
    if (handoff) {
      this.pendingHandoffs.delete(agentId);
      this.busyManagers.delete(agentId);
      await this.handOff(agentId, handoff, false);
      return;
    }
    await this.onManagerTurnEnded(agentId);
  }

  async onAgentArchived(agentId: string, parentAgentId: string | null = null): Promise<void> {
    this.pendingHandoffs.delete(agentId);
    const active = this.activeRunOfManager(agentId);
    if (active) {
      const adopted = parentAgentId !== null && (await this.archivedWithParent(parentAgentId)) && (await this.adoptOrphanedRun(active.id, parentAgentId));
      if (!adopted) await this.failRun(active.id, "manager lost (archived)");
    }
    // Archiving the manager archives its runs (an adopted one is no longer its own; another active one was just failed).
    for (const run of this.runsOfManager(agentId)) {
      if (!run.archivedAt) await this.archiveRun(run.id).catch(() => undefined);
    }
    const step = this.stepRunOf(agentId);
    if (step) await this.onStepTurnEnded(step.run.id, agentId, "lost");
  }

  /** Whether the agent was archived by Paseo's cascade from its archived parent, not on its own. */
  private async archivedWithParent(parentAgentId: string): Promise<boolean> {
    const parent = await this.api().agents.ref(parentAgentId).refresh().catch(() => null);
    return !parent || Boolean(parent.agent.archivedAt);
  }

  async onWorkspaceArchived(workspaceId: string): Promise<void> {
    for (const run of this.store.list().filter((candidate) => candidate.workspaceId === workspaceId)) {
      if (isActive(run)) await this.cancelRun(run.id, "worktree archived", null).catch(() => undefined);
      await this.store.delete(run.id);
    }
    this.reservations.delete(workspaceId);
    await this.admitQueued();
  }

  private clearTimeout(agentId: string): void {
    for (const timers of [this.timers, this.watches]) {
      const timer = timers.get(agentId);
      if (timer) clearTimeout(timer);
      timers.delete(agentId);
    }
  }

  /** Arms the step's timeout and, for an agent step, its silence check. */
  private armTimeout(run: Run, stepId: string): void {
    const step = engine.stepDef(run, stepId);
    const attempt = run.steps[stepId]!.attempts.at(-1);
    if (!attempt) return;
    this.clearTimeout(attempt.agentId);
    this.armWatch(run, stepId, Date.parse(attempt.reopenedAt ?? attempt.startedAt));
    const timeoutMs = attemptTimeoutMs(step, attempt);
    if (!timeoutMs) return;
    const due = Date.parse(attempt.reopenedAt ?? attempt.startedAt) + timeoutMs - Date.now();
    const timer = setTimeout(() => void this.onTimeout(run.id, stepId, attempt.agentId, timeoutMs), Math.max(0, due));
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(attempt.agentId, timer);
  }

  /**
   * Schedules the silence check of a running agent step: when it has shown no activity for
   * its `silence` (since `activeAt`), or shortly before its timeout, whichever comes first,
   * and not before `notBefore`.
   */
  private armWatch(run: Run, stepId: string, activeAt: number, notBefore = 0): void {
    const step = engine.stepDef(run, stepId);
    const attempt = run.steps[stepId]!.attempts.at(-1);
    if (!attempt || isScriptAttempt(attempt.agentId) || attempt.silenceReminded || run.steps[stepId]!.status !== "running") return;
    const due = silenceDue(step, attempt, activeAt);
    if (due === null) return;
    const existing = this.watches.get(attempt.agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.checkSilence(run.id, stepId, attempt.agentId), Math.max(0, due - Date.now(), notBefore - Date.now()));
    (timer as unknown as { unref?: () => void }).unref?.();
    this.watches.set(attempt.agentId, timer);
  }

  /**
   * A running step agent went silent, or its timeout is close: ask it once, in its turn, to
   * report or say what it is waiting for, and tell the manager. Otherwise check again later.
   */
  async checkSilence(runId: string, stepId: string, agentId: string): Promise<void> {
    this.watches.delete(agentId);
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || attempt?.agentId !== agentId || attempt.silenceReminded || run.steps[stepId]!.status !== "running") return;
    const step = engine.stepDef(run, stepId);
    const snapshot = await this.api().agents.ref(agentId).refresh().catch(() => null);
    // An agent that is not running has ended its turn: the turn-end hook handles it.
    if (!snapshot || snapshot.agent.status !== "running") return;
    const now = Date.now();
    const windowStart = Date.parse(attempt.reopenedAt ?? attempt.startedAt);
    // The newest timeline entry (a message, a tool call) is the agent's last activity.
    const page = await this.api().agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1 }).catch(() => null);
    const lastActivity = Date.parse((page?.entries.at(-1) as { timestamp?: string } | undefined)?.timestamp ?? "");
    const activeAt = Math.max(windowStart, Number.isNaN(lastActivity) ? windowStart : lastActivity);
    const due = silenceDue(step, attempt, activeAt);
    if (due === null) return;
    if (due > now) {
      this.armWatch(run, stepId, activeAt);
      return;
    }
    // A paused run sends nothing: look again in a minute.
    if (isPaused(run)) {
      this.armWatch(run, stepId, activeAt, now + 60_000);
      return;
    }
    const timeoutMs = attemptTimeoutMs(step, attempt);
    const deadline = timeoutMs ? windowStart + timeoutMs : null;
    // Past its timeout: the timeout ends the step.
    if (deadline !== null && now >= deadline) return;
    const silentMin = Math.round((now - activeAt) / 60_000);
    const leftMin = deadline !== null && deadline - now <= timeoutLead(timeoutMs!) ? Math.max(1, Math.round((deadline - now) / 60_000)) : null;
    const marked = await this.store.mutate(runId, (current) => {
      const last = current.steps[stepId]!.attempts.at(-1)!;
      if (last.agentId !== agentId || last.silenceReminded || current.steps[stepId]!.status !== "running") return false;
      last.silenceReminded = true;
      return true;
    });
    if (!marked) return;
    try {
      await this.api().agents.ref(agentId).send(silenceReminder(stepId, silentMin, leftMin), { activeTurnBehavior: "steer" });
    } catch (error) {
      console.error(`[playbooks] could not remind silent step "${stepId}" of ${runId}:`, errorText(error));
      return;
    }
    const why = leftMin !== null ? `its timeout fires in about ${leftMin} min` : `it has shown no activity for ${silentMin} min`;
    await this.enqueue(runId, [
      `step "${stepId}" attempt ${attempt.n} is still running and ${why}. The plugin asked it to report, or say what it is waiting for. Nothing to do now: you are woken when its turn ends.`,
    ]);
    await this.deliver(runId);
  }

  private async onTimeout(runId: string, stepId: string, agentId: string, timeoutMs: number): Promise<void> {
    this.timers.delete(agentId);
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || attempt?.agentId !== agentId || run.steps[stepId]!.status !== "running") return;
    if (isScriptAttempt(agentId)) {
      const checks = attempt.checks;
      await this.finishScript(runId, stepId, agentId, { outcome: "failure", summary: `timed out after ${Math.round(timeoutMs / 60000)} min (${checks} check(s))`, outputs: {} }, "timeout");
      return;
    }
    await this.store.mutate(runId, (current) => {
      const last = current.steps[stepId]!.attempts.at(-1)!;
      last.report ??= { outcome: "failure", summary: `timed out after ${Math.round(timeoutMs / 60000)} min`, outputs: {} };
      if (last.report.outcome !== "failure") last.report = { outcome: "failure", summary: `timed out after ${Math.round(timeoutMs / 60000)} min`, outputs: {} };
    });
    await this.onStepTurnEnded(runId, agentId, "timeout");
    await this.api().agents.ref(agentId).reload().catch(() => undefined);
  }

  // ---------------------------------------------------------------- Start (panel)

  /** Agents of a workspace that can manage a run: not step agents, not archived; most recent first. */
  async workspaceAgents(workspaceId: string) {
    const workspace = await this.api().workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    const listed = await this.api().agents.list({ filter: { projectKeys: [workspace.projectId] } });
    const recent = (agent: { lastUserMessageAt: string | null; updatedAt: string }) => agent.lastUserMessageAt ?? agent.updatedAt;
    return listed.entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt && !agent.internal && !agent.labels?.[STEP_LABEL])
      .sort((a, b) => recent(b).localeCompare(recent(a)))
      .map((agent) => ({
        id: agent.id,
        title: agent.title ?? null,
        provider: agent.provider,
        status: agent.status,
        managing: this.activeRunOfManager(agent.id)?.id ?? null,
      }));
  }

  /** Makes an existing agent of the workspace the manager: creates the run here, reloads the agent for the tools, sends the kickoff. */
  private async startWithAgent(workspaceId: string, agentId: string, playbook: Playbook, inputs: Record<string, VarValue>) {
    const handle = this.api().agents.ref(agentId);
    const agent = (await handle.refresh())?.agent;
    if (!agent || agent.archivedAt) throw new UserError("that agent no longer exists");
    if (agent.workspaceId !== workspaceId) throw new UserError("that agent is not in this workspace");
    if (agent.labels?.[STEP_LABEL]) throw new UserError("a step agent cannot manage a run");
    const managing = this.activeRunOfManager(agentId);
    if (managing) throw new UserError(`that agent already manages run ${managing.id}`);
    const run = await this.startPlaybook({ id: agentId, workspaceId, cwd: agent.cwd }, playbook.id, inputs, playbook);
    // A busy agent is never interrupted: the kickoff waits for the end of its current turn.
    if (agent.status === "running" || this.busyManagers.has(agentId)) {
      this.pendingHandoffs.set(agentId, run.id);
      return { status: "started" as const, workspaceId, managerAgentId: agentId, runId: run.id, queued: true };
    }
    await this.handOff(agentId, run.id, true);
    return { status: "started" as const, workspaceId, managerAgentId: agentId, runId: run.id, queued: false };
  }

  /** Reloads the agent (session_open then gives it the manager tools) and sends it the kickoff. */
  private async handOff(agentId: string, runId: string, rethrow: boolean): Promise<void> {
    const run = this.store.get(runId);
    if (!run || isTerminal(run.status)) return;
    try {
      const handle = this.api().agents.ref(agentId);
      await handle.reload();
      await handle.send(managerTakeover(run, engine.readySteps(run)));
    } catch (error) {
      await this.cancelRun(runId, "could not hand the run to the agent", null).catch(() => undefined);
      if (rethrow) throw error;
      console.error(`[playbooks] hand-off of ${runId} to ${agentId} failed:`, errorText(error));
    }
  }

  /** Agent config of a new Playbook Manager for this playbook. */
  private managerConfig(playbook: Playbook): AgentConfig {
    const provider = playbook.manager.provider ?? DEFAULT_PROVIDER;
    const model = playbook.manager.model ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
    if (!model) throw new UserError(`no model for the manager on provider "${provider}"; set manager.model in defaults/main.yaml`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (playbook.manager.mode) config.modeId = playbook.manager.mode;
    if (playbook.manager.thinking) config.thinkingOptionId = playbook.manager.thinking;
    preapprove(config, provider, MANAGER_TOOL_NAMES);
    return config;
  }

  async startFromPanel(input: {
    workspaceId: string;
    playbook: string;
    inputs: Record<string, VarValue>;
    force: boolean;
    agentId?: string | undefined;
    sameWorkspace?: boolean | undefined;
  }) {
    const workspace = await this.api().workspaces.ref(input.workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    const workspaceDir = workspace.workspaceDirectory ?? workspace.projectRootPath;
    const loaded = await loadPlaybooks(workspaceDir);
    const entry = loaded.entries.find((candidate) => candidate.id === input.playbook);
    if (!entry?.playbook) throw new UserError(entry ? `playbook "${input.playbook}" is invalid:\n${entry.errors.join("\n")}` : `no playbook "${input.playbook}"`);
    const playbook = entry.playbook;
    const resolved = engine.resolveRunInputs(playbook, input.inputs);
    if (!resolved.ok) throw new UserError(resolved.errors.join("; "));
    this.checkConcurrency(playbook, workspace.projectId);
    const same = this.store
      .list()
      .find(
        (run) =>
          run.projectId === workspace.projectId &&
          run.playbook.id === playbook.id &&
          !isTerminal(run.status) &&
          JSON.stringify(run.inputs) === JSON.stringify(resolved.inputs),
      );
    if (same && !input.force) {
      return { status: "duplicate" as const, runId: same.id, message: `Run ${same.id} of "${playbook.id}" is already active with the same inputs.` };
    }
    if (input.agentId) return this.startWithAgent(workspace.id, input.agentId, playbook, resolved.inputs);
    if (input.sameWorkspace) {
      const busy = this.store.list().find((run) => run.workspaceId === workspace.id && isActive(run));
      if (busy) throw new UserError(`this workspace already has an active run (${busy.id}); use "Start in a new workspace"`);
      // The new agent creates the run itself with start_playbook, which takes this reserved id.
      const runId = `run_${shortId()}`;
      this.reservations.set(workspace.id, { runId, branch: null, playbook, inputs: resolved.inputs });
      const manager = await this.api().workspaces.ref(workspace.id).agents.create({
        config: this.managerConfig(playbook),
        title: `Playbook Manager · ${playbook.title}`,
        labels: { [MANAGER_LABEL]: "true" },
        prompt: managerKickoff(playbook, resolved.inputs),
      });
      return { status: "started" as const, workspaceId: workspace.id, managerAgentId: manager.id, runId, queued: false };
    }
    const id = shortId();
    const runId = `run_${id}`;
    const branch = `playbooks/${playbook.id}-${id}`;
    const base = (await currentRef(workspaceDir)) ?? undefined;
    const headline = String(resolved.inputs.request ?? Object.values(resolved.inputs)[0] ?? "").slice(0, 60);
    const created = await this.api().workspaces.create({
      title: `${playbook.title}${headline ? `: ${headline}` : ""}`,
      source: { kind: "worktree", cwd: workspaceDir, action: "branch-off", branchName: branch, ...(base ? { refName: base } : {}) },
    });
    this.reservations.set(created.id, { runId, branch, playbook, inputs: resolved.inputs });
    const manager = await created.agents.create({
      config: this.managerConfig(playbook),
      title: `Playbook Manager · ${playbook.title}`,
      labels: { [MANAGER_LABEL]: "true" },
      prompt: managerKickoff(playbook, resolved.inputs),
    });
    return { status: "started" as const, workspaceId: created.id, managerAgentId: manager.id, runId };
  }

  hasReservation(workspaceId: string | null): boolean {
    return workspaceId !== null && this.reservations.has(workspaceId);
  }
}
