import { randomBytes } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { Playbook, Run, Step, VarValue } from "../shared/types";
import { isTerminal } from "../shared/types";
import { DEFAULT_CAP, type CapValues } from "../shared/settings";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, modeViolation } from "./cap";
import * as engine from "./engine";
import { checkoutSnapshot, currentRef, snapshotDiff } from "./git";
import { loadPlaybooks } from "./loader";
import { managerKickoff, managerTakeover, stepSystemPrompt } from "./prompts";
import type { RunStore } from "./store";

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
  "cancel_run",
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
  branch: string;
  playbook: Playbook;
  inputs: Record<string, VarValue>;
}

/** Last assistant message from a timeline page, for steps that end without reporting. */
function lastAssistantText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index]!.item;
    if (item.type === "assistant_message" && item.text) return item.text.slice(-4000);
  }
  return null;
}

export class Runtime {
  private paseo: PaseoApi | null = null;
  private reconciled: Promise<void> | null = null;
  private readonly busyManagers = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Start reserves a run id and playbook snapshot for the worktree it creates. */
  private readonly reservations = new Map<string, Reservation>();
  /** Runs started from the panel for a busy agent: agent id → run id, delivered when its turn ends. */
  private readonly pendingHandoffs = new Map<string, string>();

  constructor(
    private readonly store: RunStore,
    private readonly readCap: () => Promise<CapValues>,
  ) {}

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
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async cap(): Promise<CapValues> {
    try {
      return await this.readCap();
    } catch {
      return DEFAULT_CAP;
    }
  }

  /** After a (re)start: find step agents that stopped, re-arm timeouts, flush wake-ups. */
  private async reconcile(): Promise<void> {
    for (const run of this.store.list()) {
      if (isTerminal(run.status)) continue;
      const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
      if (!manager || manager.agent.archivedAt) {
        await this.failRun(run.id, "manager lost");
        continue;
      }
      if (manager.agent.status === "running") this.busyManagers.add(run.managerAgentId);
      for (const [stepId, state] of Object.entries(run.steps)) {
        if (state.status !== "running") continue;
        const attempt = state.attempts.at(-1)!;
        const agent = await this.api().agents.ref(attempt.agentId).refresh().catch(() => null);
        if (agent?.agent.status === "running") {
          this.armTimeout(run, stepId);
          continue;
        }
        await this.onStepTurnEnded(run.id, attempt.agentId, "lost");
      }
      await this.deliver(run.id);
    }
  }

  // ---------------------------------------------------------------- lookups

  runsOfManager(agentId: string): Run[] {
    return this.store.list().filter((run) => run.managerAgentId === agentId);
  }

  activeRunOfManager(agentId: string): Run | undefined {
    return this.runsOfManager(agentId).find((run) => !isTerminal(run.status));
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

  /** Sends queued wake-ups to the manager when it is idle, merged into one prompt. */
  async deliver(runId: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run || run.inbox.length === 0 || this.busyManagers.has(run.managerAgentId)) return;
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
      await this.api()
        .agents.ref(agentId)
        .reload()
        .catch((error) => console.error(`[playbooks] could not stop agent ${agentId}:`, errorText(error)));
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
    const active = this.store.list().find((run) => run.workspaceId === workspace.id && !isTerminal(run.status));
    if (active) throw new UserError(`this workspace already has an active run (${active.id}); one active run per workspace`);
    const workspaceDir = workspace.workspaceDirectory ?? manager.cwd;
    const reservation = this.reservations.get(workspace.id);
    let playbook: Playbook | null = preloaded ?? (reservation && reservation.playbook.id === playbookId ? reservation.playbook : null);
    if (!playbook) {
      const loaded = await loadPlaybooks(workspaceDir, await this.cap());
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
    return run;
  }

  private checkConcurrency(playbook: Playbook, projectId: string): void {
    if (playbook.concurrency === undefined) return;
    const active = this.store
      .list()
      .filter((run) => run.projectId === projectId && run.playbook.id === playbook.id && !isTerminal(run.status));
    if (active.length >= playbook.concurrency) {
      throw new UserError(
        `playbook "${playbook.id}" allows ${playbook.concurrency} active run(s) in this project; active: ${active.map((run) => run.id).join(", ")}`,
      );
    }
  }

  async startStep(managerId: string, runId: string, stepId: string, brief: string): Promise<{ agentId: string; attempt: number }> {
    const run = this.ownedRun(managerId, runId);
    const step = engine.stepDef(run, stepId);
    if (step.kind !== "agent" || !step.role) throw new UserError(`step "${stepId}" is a gate; call request_gate`);
    if (run.steps[stepId]!.status !== "ready") {
      throw new UserError(`step "${stepId}" is ${run.steps[stepId]!.status}, not ready (ready now: ${engine.readySteps(run).join(", ") || "none"})`);
    }
    const role = run.playbook.roles[step.role]!;
    const config = await this.stepAgentConfig(run, step);
    const snapshot = role.readonly ? await checkoutSnapshot(run.workspaceDir) : null;
    const attemptNo = run.steps[stepId]!.attempts.length + 1;
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
    return { agentId: agent.id, attempt: started.attempt.n };
  }

  private async stepAgentConfig(run: Run, step: Step) {
    const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    const provider = step.agent.provider ?? manager?.agent.provider ?? DEFAULT_PROVIDER;
    const model =
      step.agent.model ?? (manager?.agent.provider === provider ? manager?.agent.model ?? undefined : undefined) ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
    if (!model) throw new UserError(`step "${step.id}": no model for provider "${provider}"; set agent.model in the playbook`);
    const violation = modeViolation(await this.cap(), provider, step.agent.mode);
    if (violation) throw new UserError(`step "${step.id}": ${violation}`);
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
    if (!result.alreadyDecided && decision.via === "panel") {
      const run = this.store.get(runId)!;
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

  /** Hides a finished run from the panel; nothing else changes (no agent is archived or stopped). */
  async archiveRun(runId: string): Promise<string> {
    return this.store.mutate(runId, (run) => {
      if (!isTerminal(run.status)) throw new UserError(`run ${runId} is ${run.status}: cancel it before archiving`);
      run.archivedAt ??= nowIso();
      return run.archivedAt;
    });
  }

  async cancelRun(runId: string, reason: string, notifyManager: boolean): Promise<Run> {
    const effects = await this.store.mutate(runId, (current) => engine.cancelRun(current, reason, nowIso()));
    await this.applyEffects(runId, effects);
    if (notifyManager) {
      await this.enqueue(runId, [`The run was canceled from the panel: ${reason}. Tell the human and stop.`]);
      await this.deliver(runId);
    }
    return this.store.get(runId)!;
  }

  private async failRun(runId: string, reason: string): Promise<void> {
    const effects = await this.store.mutate(runId, (current) => engine.failRun(current, reason, nowIso()));
    await this.applyEffects(runId, effects);
  }

  /** Sends a follow-up to the current attempt's agent, in the same conversation. */
  async nudgeStep(runId: string, stepId: string, message: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    const state = run.steps[stepId];
    const attempt = state?.attempts.at(-1);
    if (!state || !attempt) throw new UserError(`step "${stepId}" has no attempt to nudge`);
    if (isTerminal(run.status)) throw new UserError(`run ${run.id} is ${run.status}`);
    if (state.status === "reported") {
      // The agent works again: its next turn end reports again.
      await this.store.mutate(runId, (current) => {
        const currentState = current.steps[stepId]!;
        currentState.status = "running";
        const last = currentState.attempts.at(-1)!;
        last.endedAt = null;
        last.turnEnd = null;
      });
      this.armTimeout(this.store.get(runId)!, stepId);
    } else if (state.status !== "running") {
      throw new UserError(`step "${stepId}" is ${state.status}; only a running or reported step can be nudged`);
    }
    await this.api().agents.ref(attempt.agentId).send(message, { activeTurnBehavior: "steer" });
  }

  async askManagerToRetry(runId: string, stepId: string): Promise<void> {
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
      ? `${head} reported ${report.outcome}: ${report.summary}${Object.keys(report.outputs).length ? ` Outputs: ${JSON.stringify(report.outputs)}.` : ""}`
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

  async onAgentArchived(agentId: string): Promise<void> {
    this.pendingHandoffs.delete(agentId);
    const active = this.activeRunOfManager(agentId);
    if (active) await this.failRun(active.id, "manager lost (archived)");
    const step = this.stepRunOf(agentId);
    if (step) await this.onStepTurnEnded(step.run.id, agentId, "lost");
  }

  async onWorkspaceArchived(workspaceId: string): Promise<void> {
    for (const run of this.store.list().filter((candidate) => candidate.workspaceId === workspaceId)) {
      if (!isTerminal(run.status)) await this.cancelRun(run.id, "worktree archived", false).catch(() => undefined);
      await this.store.delete(run.id);
    }
    this.reservations.delete(workspaceId);
  }

  private clearTimeout(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private armTimeout(run: Run, stepId: string): void {
    const step = engine.stepDef(run, stepId);
    const attempt = run.steps[stepId]!.attempts.at(-1);
    if (!step.timeoutMs || !attempt) return;
    this.clearTimeout(attempt.agentId);
    const due = Date.parse(attempt.startedAt) + step.timeoutMs - Date.now();
    const timer = setTimeout(() => void this.onTimeout(run.id, stepId, attempt.agentId, step.timeoutMs!), Math.max(0, due));
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(attempt.agentId, timer);
  }

  private async onTimeout(runId: string, stepId: string, agentId: string, timeoutMs: number): Promise<void> {
    this.timers.delete(agentId);
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || attempt?.agentId !== agentId || run.steps[stepId]!.status !== "running") return;
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
      await this.cancelRun(runId, "could not hand the run to the agent", false).catch(() => undefined);
      if (rethrow) throw error;
      console.error(`[playbooks] hand-off of ${runId} to ${agentId} failed:`, errorText(error));
    }
  }

  async startFromPanel(input: { workspaceId: string; playbook: string; inputs: Record<string, VarValue>; force: boolean; agentId?: string | undefined }) {
    const workspace = await this.api().workspaces.ref(input.workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    const workspaceDir = workspace.workspaceDirectory ?? workspace.projectRootPath;
    const loaded = await loadPlaybooks(workspaceDir, await this.cap());
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
    const provider = playbook.manager.provider ?? DEFAULT_PROVIDER;
    const model = playbook.manager.model ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
    if (!model) throw new UserError(`no model for the manager on provider "${provider}"; set manager.model in defaults/main.yaml`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (playbook.manager.mode) config.modeId = playbook.manager.mode;
    if (playbook.manager.thinking) config.thinkingOptionId = playbook.manager.thinking;
    preapprove(config, provider, MANAGER_TOOL_NAMES);
    const manager = await created.agents.create({
      config,
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
