import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The daemon API handed to plugin handlers (typed via the SDK, so the build needs no @getpaseo/client). */
type PaseoApi = PluginHandlerContext["paseo"];
import type { Attempt, Gate, Job, Playbook, Run, Step, VarValue } from "../shared/types";
import {
  SCRIPT_NOT_YET,
  attemptTimeoutMs,
  handoffAttemptId,
  isActive,
  isAgentlessAttempt,
  isPipeline,
  isHandoffAttempt,
  isPaused,
  isScriptAttempt,
  isStepLive,
  isTerminal,
  restartBlocker,
  scriptAttemptId,
} from "../shared/types";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults";
import * as engine from "./engine";
import { checkoutSnapshot, currentRef, defaultBranch, fastForward, freshRef, snapshotDiff } from "./git";
import { loadPlaybooks } from "./loader";
import { BusError, EventBus, type BusEvent, type Notifier, type Subscription } from "./bus";
import { OversightProducer, registerOversightTypes } from "./oversight-events";
import { gateListing, listAttention, type GateFilter } from "./overseer";
import { managerLostNotice, gateDeciderPrompt, gateDeciderSystemPrompt, gateDecisionReminder, managerAfterRestart, managerKickoff, managerTakeover, reportReminder, resumeAfterRestart, silenceReminder, singletonKickoff, stepSystemPrompt } from "./prompts";
import { askHumanText, choicesOfGate, waitsForHuman } from "../shared/gates";
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
  "escalate_gate",
  "nudge_step",
  "get_run",
  "list_runs",
  "cancel_run",
  "restart_run",
  "validate_playbooks",
  "settle_job",
];
export const STEP_TOOL_NAMES = ["report_step_result"];
export const GATE_TOOL_NAMES = ["report_gate_decision"];

type AgentConfig = { provider: string; modeId?: string; thinkingOptionId?: string; options?: { allowedTools: string[] } };

/** Pre-approves our own tools so unattended agents in `default` mode are not blocked on them. */
function preapprove(config: AgentConfig, provider: string, tools: string[]): AgentConfig {
  if (provider === "claude") config.options = { allowedTools: tools.map((tool) => `mcp__paseo__${tool}`) };
  return config;
}

const MANAGER_LABEL = "playbooks/manager";
export const STEP_LABEL = "playbooks/step";
export const RUN_LABEL = "playbooks/run";
/** On a gate's role decider agent: the gate id. */
export const GATE_LABEL = "playbooks/gate";

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomBytes(3).toString("hex");
}

/** Longest run name kept: it labels a tab. */
const RUN_NAME_MAX = 32;

/** The manager's name for a run, on one line and cut to fit a tab; none when blank. */
export function runName(name: string | undefined): string | null {
  const line = (name ?? "").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, RUN_NAME_MAX).trim() : null;
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
      ? `exit ${SCRIPT_NOT_YET} ("not yet"), but the step has no \`script.poll\``
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
  // A singleton run's open jobs, as {{ run.jobs }} gives them to prompts.
  if (run.playbook.singleton) env.PLAYBOOK_JOBS = JSON.stringify(engine.openJobs(run));
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

/** The manager's line for a step agent's report. */
function reportedLine(stepId: string, n: number, report: { outcome: string; summary: string; outputs: Record<string, unknown> }): string {
  return `step "${stepId}" attempt ${n} reported ${report.outcome}: ${report.summary}${Object.keys(report.outputs).length ? ` Outputs: ${JSON.stringify(report.outputs)}.` : ""}`;
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
  /**
   * Managers of a station's previous train: archived once their turn ends, and never woken
   * again (sending to an archived agent brings it back).
   */
  private readonly retiredManagers = new Set<string>();
  /** Train gates announced to the runs of their jobs, as "<trainId>/<gateId>". */
  private readonly trainGates = new Set<string>();
  /** Train step attempts whose `settle` output was applied, as "<trainId>/<stepId>/<attempt>". */
  private readonly settledSteps = new Set<string>();
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
  /** Pipelines being created (with their workspace), by project and playbook. */
  private readonly creatingPipelines = new Map<string, Promise<Run>>();
  /** The plugin's own work (scripts, hand-offs, departures) runs one pass at a time; a call during a pass asks for another. */
  private ticking = false;
  private tickAgain = false;
  /** Role deciders reminded once to decide, by agent id. */
  private readonly remindedDeciders = new Set<string>();
  /** Role deciders of closed gates already stopped, by agent id. */
  private readonly stoppedDeciders = new Set<string>();

  /** The event bus (bus.ts) and its first producer, the runs (oversight-events.ts). */
  readonly bus: EventBus;
  private readonly producer: OversightProducer;
  private eventsScanning = false;
  private eventsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: RunStore,
    private readonly options: { dataDir?: string; debounceMs?: number; pollMs?: number } = {},
  ) {
    const dir = options.dataDir ?? path.dirname(store.dir);
    this.bus = new EventBus({ events: path.join(dir, "events.json"), subscriptions: path.join(dir, "subscriptions.json") }, options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs });
    registerOversightTypes(this.bus);
    this.bus.registerNotifier("agent", this.agentNotifier());
    this.producer = new OversightProducer(this.bus);
  }

  /** Sends a subscription's events as a plain-text message to its agent; an archived or missing agent is "gone". */
  private agentNotifier(): Notifier {
    return {
      deliver: async (subscription: Subscription, _events: BusEvent[], text: string) => {
        const agent = await this.api().agents.ref(subscription.sink.target).refresh().catch(() => null);
        if (!agent || agent.agent.archivedAt) return "gone";
        await this.api().agents.ref(subscription.sink.target).send(text, { activeTurnBehavior: "steer" });
        return "delivered";
      },
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Every hook, tool and RPC context hands us the daemon API; the first one triggers reconcile. */
  attach(paseo: PaseoApi): Promise<void> {
    this.paseo ??= paseo;
    this.reconciled ??= this.reconcile().catch((error) => console.error("[playbooks] reconcile failed:", error));
    if (!this.eventsTimer) {
      this.eventsTimer = setInterval(() => void this.watchEvents().catch((error) => console.error("[playbooks] event watch failed:", errorText(error))), this.options.pollMs ?? 2000);
      (this.eventsTimer as unknown as { unref?: () => void }).unref?.();
    }
    return this.reconciled;
  }

  private api(): PaseoApi {
    if (!this.paseo) throw new Error("Paseo API not attached yet");
    return this.paseo;
  }

  /** Stops timers and scripts; resolves once the run files written in flight are on disk, after which nothing is written. */
  dispose(): Promise<void> {
    if (this.eventsTimer) clearInterval(this.eventsTimer);
    this.eventsTimer = null;
    for (const timer of [...this.timers.values(), ...this.watches.values()]) clearTimeout(timer);
    this.timers.clear();
    this.watches.clear();
    for (const id of [...this.scripts.keys()]) this.stopScript(id);
    return Promise.all([this.store.close(), this.bus.close()]).then(() => undefined);
  }

  /**
   * After a (re)start: re-arm timeouts, ask step agents whose turn the restart cut to carry on,
   * treat the ones that cannot as lost, wake idle managers of stalled runs, flush wake-ups.
   */
  private async reconcile(): Promise<void> {
    for (const run of this.store.list()) {
      if (run.status === "boarding" || (isPipeline(run) && !isTerminal(run.status) && (run.playbook.singleton?.stations.length ?? 0) === 0)) {
        // Boarding runs and singleton runs of v0.30.0 were replaced by pipelines.
        await this.failRun(run.id, "singleton runs of v0.30.0 were replaced by pipelines; hand the job off again");
        continue;
      }
      if (!isActive(run) || isPipeline(run)) continue;
      const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
      if (!manager || manager.agent.archivedAt) {
        await this.failManagerLost(run.id, "manager lost", `manager ${run.managerAgentId} ${manager ? "was archived" : "no longer exists"} before the daemon started: the plugin was not running to see who archived it`, null);
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
        if (isHandoffAttempt(attempt.agentId)) {
          // Its job waits in run state: only its timeout needs arming again.
          this.armTimeout(run, stepId);
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
      await this.reconcileDeciders(run.id);
      await this.wakeStalledManager(run.id);
      await this.deliver(run.id);
    }
    // Train gates open before the restart were announced then: only their decisions are left to tell.
    for (const run of this.store.list()) {
      if (!run.train || isTerminal(run.status)) continue;
      for (const gate of run.gates) if (gate.status === "pending") this.trainGates.add(`${run.id}/${gate.id}`);
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

  /** Open gates and asks across the runs (see overseer.ts). */
  attention(filter: GateFilter = {}) {
    return listAttention(this.store.list(), Date.now(), filter);
  }

  // ---------------------------------------------------------------- events

  async subscribeEvents(agentId: string, types: string[], filter: Record<string, string | number | boolean>): Promise<Subscription> {
    try {
      if (typeof filter.runId === "string" && !this.store.get(filter.runId)) throw new UserError(`unknown run "${filter.runId}"`);
      return await this.bus.subscribe(agentId, { kind: "agent", target: agentId }, types, filter);
    } catch (error) {
      throw error instanceof BusError ? new UserError(error.message) : error;
    }
  }

  async unsubscribeEvents(agentId: string, id: string): Promise<void> {
    await this.bus.unsubscribe(agentId, id).catch((error: unknown) => {
      throw error instanceof BusError ? new UserError(error.message) : error;
    });
  }

  /** One pass: producers emit what changed, then the bus delivers what has waited out its debounce. */
  async watchEvents(now = Date.now()): Promise<void> {
    if (this.eventsScanning) return;
    this.eventsScanning = true;
    try {
      await this.producer.scan(this.store.list(), now);
      await this.bus.flush(now);
    } finally {
      this.eventsScanning = false;
    }
  }

  /** A run a tool only reads: any run, whoever manages it. Writes go through ownedRun. */
  readableRun(callerId: string, runId: string | undefined): Run {
    if (!runId) return this.ownedRun(callerId, runId);
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    return run;
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
    // A pipeline has no manager: nothing to wake.
    if (!run || !run.managerAgentId || run.inbox.length === 0 || isPaused(run) || this.busyManagers.has(run.managerAgentId)) return;
    if (this.retiredManagers.has(run.managerAgentId)) return;
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
    if (this.retiredManagers.has(agentId)) return this.archiveStepAgent(agentId);
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
      if (isHandoffAttempt(agentId)) {
        await this.withdrawHandoff(runId, agentId, "its hand-off step was canceled or reset");
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

  // ---------------------------------------------------------------- gate deciders

  /** The pending or closed gate whose role decider is this agent. */
  private deciderOf(agentId: string): { run: Run; gate: Gate } | null {
    for (const run of this.store.list()) {
      const gate = run.gates.find((candidate) => candidate.deciderAgentId === agentId);
      if (gate) return { run, gate };
    }
    return null;
  }

  /** Starts the role decider of each open gate that has none yet, and stops those of gates closed without them. */
  private async runDeciders(): Promise<void> {
    for (const run of this.store.list()) {
      for (const gate of run.gates) {
        const agentId = gate.deciderAgentId;
        // Its own decision is stopped when its turn ends, not during the tool call.
        if (!agentId || gate.status === "pending" || gate.decidedVia === "role" || this.stoppedDeciders.has(agentId)) continue;
        this.stoppedDeciders.add(agentId);
        await this.archiveStepAgent(agentId);
      }
      if (!isActive(run) || isPaused(run) || isPipeline(run)) continue;
      for (const gate of run.gates) {
        if (gate.status !== "pending" || gate.decider.by !== "role" || gate.deciderAgentId || gate.escalated !== null) continue;
        await this.startDecider(run.id, gate.id).catch((error: unknown) => this.escalate(run.id, gate.id, `its agent could not start: ${errorText(error)}`));
      }
    }
  }

  private async startDecider(runId: string, gateId: string): Promise<void> {
    const run = this.store.get(runId)!;
    const gate = run.gates.find((candidate) => candidate.id === gateId)!;
    const role = run.playbook.roles[gate.decider.role ?? ""];
    if (!role) throw new UserError(`role "${gate.decider.role}" is not in the run's playbook`);
    const choices = choicesOfGate(gate, engine.stepDef(run, gate.stepId));
    const config = await this.stepAgentConfig(run, { id: gate.stepId, agent: gate.decider.agent ?? role.agent }, GATE_TOOL_NAMES);
    const agent = await this.api()
      .workspaces.ref(run.workspaceId)
      .agents.create({
        config: { ...config, systemPrompt: gateDeciderSystemPrompt(run.playbook, gate, role, choices) },
        parent: run.managerAgentId,
        title: `${run.playbook.title} · ${role.title} · ${gate.id}`,
        labels: { [RUN_LABEL]: run.id, [GATE_LABEL]: gate.id },
      });
    await this.store.mutate(runId, (current) => engine.startGateDecider(current, gateId, agent.id, nowIso()));
    await agent.send(gateDeciderPrompt(run, gate, choices));
  }

  /** report_gate_decision: the role decider picks a choice, or leaves the gate to a human. */
  async reportGateDecision(agentId: string, input: { decision: string; comment: string }): Promise<string> {
    const found = this.deciderOf(agentId);
    if (!found) throw new UserError("not found: you are not deciding a gate of a playbook run");
    const { run, gate } = found;
    if (gate.status !== "pending") return `Gate ${gate.id} is already decided (${gate.status}${gate.decidedVia ? ` via ${gate.decidedVia}` : ""}). Stop here: end your turn.`;
    if (gate.escalated !== null) return `Gate ${gate.id} was already left to a human. Stop here: end your turn.`;
    if (!input.comment.trim()) throw new UserError("comment: give your reason");
    if (input.decision === "escalate") {
      await this.escalate(run.id, gate.id, input.comment);
      return `Gate ${gate.id} is left to a human. Stop here: end your turn.`;
    }
    const role = gate.decider.role ?? "?";
    const result = await this.decideGate(run.id, gate.id, { decision: input.decision, comment: input.comment.trim(), by: role, via: "role", now: nowIso() });
    if (!result.alreadyDecided) {
      const current = this.store.get(run.id)!;
      await this.enqueue(run.id, [
        `Gate ${gate.stepId} ${input.decision} by role "${role}": "${input.comment.trim()}".`,
        current.status === "running" ? `Ready: ${engine.readySteps(current).join(", ") || "none"}.` : `Run is ${current.status}.`,
      ]);
      await this.deliver(run.id);
    }
    return `Decision "${input.decision}" recorded for gate ${gate.id}. Stop here: end your turn.`;
  }

  /** escalate_gate: the manager of a manager-decided gate hands it to a human before asking one in chat. */
  async escalateByManager(managerId: string, runId: string, ref: string, reason: string): Promise<string> {
    const run = this.ownedRun(managerId, runId);
    const gate = engine.findGate(run, ref);
    if (!gate) throw new UserError(`no gate "${ref}" in run ${run.id}`);
    if (gate.status !== "pending") return `Gate ${gate.id} is already decided (${gate.status}${gate.decidedVia ? ` via ${gate.decidedVia}` : ""}). Nothing to escalate.`;
    if (gate.decider.by !== "manager") throw new UserError(`gate "${gate.id}" is decided by ${engine.deciderText(gate.decider)}, not by you: ask a human as usual, no escalate_gate`);
    if (gate.escalated !== null) return `Gate ${gate.id} was already left to a human. Ask one.`;
    if (!reason.trim()) throw new UserError("reason: say why you leave it to a human");
    await this.store.mutate(run.id, (current) => engine.escalateGate(current, gate.id, reason, nowIso()));
    const current = this.store.get(run.id)!;
    const updated = current.gates.find((candidate) => candidate.id === gate.id)!;
    return `Gate ${gate.id} is left to a human. ${askHumanText(updated, choicesOfGate(updated, engine.stepDef(current, updated.stepId)))}`;
  }

  /** The manager or role decider leaves the gate to a human: the manager is told to ask one. */
  private async escalate(runId: string, gateId: string, reason: string): Promise<void> {
    const escalated = await this.store.mutate(runId, (current) => engine.escalateGate(current, gateId, reason, nowIso()));
    if (!escalated) return;
    const run = this.store.get(runId)!;
    const gate = run.gates.find((candidate) => candidate.id === gateId)!;
    await this.enqueue(runId, [
      `${engine.deciderText(gate.decider)} left gate ${gate.id} ("${gate.stepId}") to a human: ${gate.escalated}.`,
      askHumanText(gate, choicesOfGate(gate, engine.stepDef(run, gate.stepId))),
    ]);
    await this.deliver(runId);
    // A train's gate is now announced to the runs whose jobs it carries.
    if (run.train) await this.tick();
  }

  private async onDeciderTurnEnded(runId: string, gateId: string, agentId: string, outcome: "completed" | "failed" | "canceled"): Promise<void> {
    const run = this.store.get(runId);
    const gate = run?.gates.find((candidate) => candidate.id === gateId);
    if (!run || !gate) return;
    if (gate.status === "pending" && gate.escalated === null) {
      if (outcome === "completed" && !this.remindedDeciders.has(agentId) && !isPaused(run)) {
        this.remindedDeciders.add(agentId);
        const sent = await this.api()
          .agents.ref(agentId)
          .send(gateDecisionReminder(gate.id))
          .then(() => true, () => false);
        if (sent) return;
      }
      await this.escalate(runId, gateId, outcome === "completed" ? "its agent ended without a decision" : `its agent's turn ${outcome}`);
    }
    if (this.stoppedDeciders.has(agentId) || engine.stepDef(run, gate.stepId).archiveAgents === false) return;
    this.stoppedDeciders.add(agentId);
    await this.archiveStepAgent(agentId);
  }

  /** After a daemon restart: a role decider cut mid-turn is asked to carry on; one that is gone escalates. */
  private async reconcileDeciders(runId: string): Promise<void> {
    for (const gate of this.store.get(runId)?.gates ?? []) {
      if (gate.status !== "pending" || !gate.deciderAgentId || gate.escalated !== null) continue;
      const agent = await this.api().agents.ref(gate.deciderAgentId).refresh().catch(() => null);
      if (agent?.agent.status === "running") continue;
      if (!agent || agent.agent.archivedAt) {
        await this.escalate(runId, gate.id, "its agent was lost in a daemon restart");
        continue;
      }
      this.remindedDeciders.add(gate.deciderAgentId);
      const sent = await this.api()
        .agents.ref(gate.deciderAgentId)
        .send(gateDecisionReminder(gate.id))
        .then(() => true, () => false);
      if (!sent) await this.escalate(runId, gate.id, "its agent could not be resumed after a daemon restart");
    }
  }

  // ---------------------------------------------------------------- manager tools

  async startPlaybook(
    manager: { id: string; workspaceId: string | null; cwd: string },
    playbookId: string,
    inputs: Record<string, unknown>,
    options: { playbook?: Playbook; name?: string } = {},
  ): Promise<Run> {
    if (!manager.workspaceId) throw new UserError("this agent has no workspace");
    const workspace = await this.api().workspaces.ref(manager.workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    const active = this.store.list().find((run) => run.workspaceId === workspace.id && isActive(run));
    if (active) throw new UserError(`this workspace already has an active run (${active.id}); one active run per workspace`);
    const workspaceDir = workspace.workspaceDirectory ?? manager.cwd;
    const reservation = this.reservations.get(workspace.id);
    let playbook: Playbook | null = options.playbook ?? (reservation && reservation.playbook.id === playbookId ? reservation.playbook : null);
    if (!playbook) {
      const loaded = await loadPlaybooks(workspaceDir);
      const entry = loaded.entries.find((candidate) => candidate.id === playbookId);
      if (!entry) throw new UserError(`no playbook "${playbookId}" in this workspace (have: ${loaded.entries.map((e) => e.id).join(", ") || "none"})`);
      if (!entry.playbook) throw new UserError(`playbook "${playbookId}" is invalid:\n${entry.errors.join("\n")}`);
      playbook = entry.playbook;
    }
    if (playbook.singleton) return this.startPipeline(workspaceDir, workspace.projectId, playbook);
    this.checkConcurrency(playbook, workspace.projectId);
    const run = engine.newRun({
      id: reservation?.runId ?? `run_${shortId()}`,
      playbook,
      workspaceId: workspace.id,
      workspaceDir,
      projectId: workspace.projectId,
      branch: reservation?.branch ?? (await currentRef(workspaceDir)),
      managerAgentId: manager.id,
      name: runName(options.name),
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
    // Every place that may make steps ready ends here, so the plugin's own work starts here too.
    await this.tick();
  }

  /** Starts ready script and hand-off steps, ends the jobs of ended singleton runs, and departs boarding runs. */
  private async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.startScripts();
        await this.startHandoffs();
        await this.runDeciders();
        await this.noticeTrainGates();
        await this.endTrains();
        await this.departTrains();
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- hand-offs and singleton pipelines

  /** Starts the ready hand-off steps of every active, unpaused run: each hands a job to its singleton's pipeline. */
  private async startHandoffs(): Promise<void> {
    for (const run of this.store.list()) {
      if (!isActive(run) || isPaused(run) || isPipeline(run)) continue;
      for (const stepId of engine.readyHandoffs(run)) {
        const attemptId = await this.store.mutate(run.id, (current) => {
          if (current.steps[stepId]!.status !== "ready" || isPaused(current)) return null;
          const id = handoffAttemptId(current.id, stepId, current.steps[stepId]!.attempts.length + 1);
          engine.startAttempt(current, stepId, { agentId: id, brief: "", now: nowIso(), readonlySnapshot: null });
          return id;
        });
        if (!attemptId) continue;
        this.armTimeout(this.store.get(run.id)!, stepId);
        const queued = await this.queueJob(run.id, stepId, attemptId).catch((error: unknown) => errorText(error));
        if (typeof queued === "string") await this.finishHandoff(run.id, stepId, attemptId, { outcome: "failure", summary: `could not hand off: ${queued}`, outputs: {} });
      }
    }
  }

  /** Puts the hand-off's job in its singleton's pipeline (created with its workspace if needed). */
  private async queueJob(runId: string, stepId: string, attemptId: string): Promise<true> {
    const run = this.store.get(runId)!;
    const step = engine.stepDef(run, stepId);
    const loaded = await loadPlaybooks(run.workspaceDir);
    const entry = loaded.entries.find((candidate) => candidate.id === step.handoff);
    if (!entry?.playbook) throw new UserError(entry ? `playbook "${step.handoff}" is invalid: ${entry.errors[0] ?? ""}` : `no playbook "${step.handoff}" in ${run.workspaceDir}`);
    if (!entry.playbook.singleton) throw new UserError(`playbook "${entry.playbook.id}" is not a singleton`);
    const pipeline = await this.pipelineOf(entry.playbook, run.projectId, run.workspaceDir);
    const values = Object.fromEntries(
      Object.entries(engine.stepInputs(run, step)).flatMap(([name, value]) => (value.value === undefined ? [] : [[name, value.value]])),
    );
    // The pipeline's own copy of the playbook is the one that counts.
    const inputs = engine.resolveJobInputs(pipeline.playbook, values);
    if (!inputs.ok) throw new UserError(inputs.errors.join("; "));
    const job: Job = {
      id: `job_${shortId()}`,
      fromRunId: run.id,
      fromStepId: stepId,
      attempt: run.steps[stepId]!.attempts.length,
      label: `${run.playbook.title} · ${run.id}`,
      inputs: inputs.inputs,
      status: "open",
      outcome: null,
      summary: null,
      outputs: {},
      createdAt: nowIso(),
      endedAt: null,
      passed: [],
      waiting: [],
      riding: [],
      failedRides: {},
      detached: step.handoffWait === false,
    };
    await this.store.mutate(pipeline.id, (current) => engine.addJob(current, job, nowIso()));
    await this.store.mutate(run.id, (current) => {
      const attempt = current.steps[stepId]!.attempts.at(-1)!;
      if (attempt.agentId !== attemptId) return;
      attempt.job = { runId: pipeline.id, jobId: job.id };
      attempt.lastMessage = `Waiting at ${job.waiting.map((place) => `"${place.station}"`).join(", ") || "the first station"} of "${pipeline.playbook.title}".`;
    });
    // Fire and forget: the step is done now; the job is the pipeline's from here on.
    if (job.detached) {
      const at = job.waiting.map((place) => `"${place.station}"`).join(", ") || "its first station";
      await this.finishHandoff(run.id, stepId, attemptId, { outcome: step.outcomes[0]!, summary: `Handed job ${job.id} to "${pipeline.playbook.title}" (${pipeline.id}), waiting at ${at}; not waiting for its result.`, outputs: {} });
    }
    this.tickAgain = true;
    return true;
  }

  /** The active pipeline of a singleton in the project; created with its workspace when there is none. */
  private async pipelineOf(playbook: Playbook, projectId: string, sourceDir: string): Promise<Run> {
    const active = () => this.store.list().find((run) => isPipeline(run) && !isTerminal(run.status) && run.projectId === projectId && run.playbook.id === playbook.id);
    const existing = active();
    if (existing) return existing;
    const key = `${projectId}|${playbook.id}`;
    // Two hand-offs at once must not create two pipelines.
    let creating = this.creatingPipelines.get(key);
    if (!creating) {
      creating = this.createPipeline(playbook, projectId, sourceDir).finally(() => this.creatingPipelines.delete(key));
      this.creatingPipelines.set(key, creating);
    }
    return creating;
  }

  /** Creates the singleton's shared workspace from its branch, and its pipeline run there. */
  private async createPipeline(playbook: Playbook, projectId: string, sourceDir: string): Promise<Run> {
    const base = playbook.singleton?.branch ?? (await defaultBranch(sourceDir)) ?? undefined;
    // Branch off origin's copy: the source checkout's local branch may be far behind.
    const ref = base ? await freshRef(sourceDir, base) : undefined;
    const id = shortId();
    const branch = `playbooks/${playbook.id}-${id}`;
    const created = await this.api().workspaces.create({
      title: playbook.title,
      source: { kind: "worktree", cwd: sourceDir, action: "branch-off", branchName: branch, ...(ref ? { refName: ref } : {}) },
    });
    const workspace = await this.api().workspaces.ref(created.id).refresh();
    const workspaceDir = workspace?.workspaceDirectory ?? sourceDir;
    const entry = (await loadPlaybooks(workspaceDir)).entries.find((candidate) => candidate.id === playbook.id);
    if (!entry?.playbook?.singleton) {
      // Nothing will run there: do not leave an empty workspace behind.
      await this.api().workspaces.ref(created.id).archive().catch((error) => console.error(`[playbooks] could not archive workspace ${created.id}:`, errorText(error)));
      throw new UserError(entry ? `playbook "${playbook.id}" is not a valid singleton on ${ref ?? "its branch"}: ${entry.errors[0] ?? ""}` : `no playbook "${playbook.id}" on ${ref ?? "its branch"}`);
    }
    const run = engine.newPipelineRun({ id: `run_${id}`, playbook: entry.playbook, workspaceId: created.id, workspaceDir, projectId, branch, now: nowIso() });
    await this.store.create(run);
    return run;
  }

  /** Start (panel) or start_playbook on a singleton: its pipeline, created with its workspace if needed. */
  private async startPipeline(sourceDir: string, projectId: string, playbook: Playbook): Promise<Run> {
    const run = await this.pipelineOf(playbook, projectId, sourceDir);
    await this.tick();
    return this.store.get(run.id)!;
  }

  /** The trains (runs) of a pipeline, newest first. */
  private trainsOf(pipelineId: string): Run[] {
    return this.store.list().filter((run) => run.train?.pipelineId === pipelineId);
  }

  /** Each free station of each active pipeline takes its next train from its waiting list. */
  private async departTrains(): Promise<void> {
    for (const pipeline of this.store.list()) {
      if (!isPipeline(pipeline) || isTerminal(pipeline.status) || isPaused(pipeline)) continue;
      const busy = new Set(this.trainsOf(pipeline.id).filter((train) => !isTerminal(train.status)).map((train) => train.train!.station));
      const due = (pipeline.playbook.singleton?.stations ?? []).filter((station) => !busy.has(station.id) && engine.nextTrainJobs(pipeline, station.id).length > 0);
      if (due.length === 0) continue;
      // Between trains, the workspace follows its branch: a merged change applies from the next train.
      if (busy.size === 0) await this.refreshPipeline(pipeline.id);
      for (const station of due) {
        await this.departTrain(pipeline.id, station.id).catch((error: unknown) => console.error(`[playbooks] train of "${station.id}" in ${pipeline.id} could not start:`, errorText(error)));
      }
    }
  }

  /** Fast-forwards an idle pipeline's workspace and reads its playbook again; jobs at a station that is gone fail. */
  private async refreshPipeline(pipelineId: string): Promise<void> {
    const pipeline = this.store.get(pipelineId)!;
    const ref = pipeline.playbook.singleton?.branch ?? (await defaultBranch(pipeline.workspaceDir));
    if (ref) await fastForward(pipeline.workspaceDir, ref);
    const entry = (await loadPlaybooks(pipeline.workspaceDir)).entries.find((candidate) => candidate.id === pipeline.playbook.id);
    if (!entry?.playbook?.singleton) return;
    const playbook = entry.playbook;
    const ended = await this.store.mutate(pipelineId, (current) => {
      current.playbook = playbook;
      const stations = new Set(playbook.singleton!.stations.map((station) => station.id));
      const lost = current.jobs.filter((job) => job.status === "open" && job.waiting.some((place) => !stations.has(place.station))).map((job) => job.id);
      return engine.failJobs(current, lost, "its station was removed from the playbook", nowIso());
    });
    for (const job of ended) await this.deliverJob(job, { outcome: "failure", summary: job.summary ?? "station removed", outputs: {} });
  }

  /** Starts a station's next train: a fresh manager in the pipeline's workspace, and a run of the station carrying its jobs. */
  private async departTrain(pipelineId: string, stationId: string): Promise<void> {
    const pipeline = this.store.get(pipelineId)!;
    const jobs = engine.nextTrainJobs(pipeline, stationId);
    if (jobs.length === 0) return;
    const playbook = engine.stationPlaybook(pipeline.playbook, stationId);
    const manager = await this.api().workspaces.ref(pipeline.workspaceId).agents.create({
      config: this.managerConfig(playbook),
      title: `Playbook Manager · ${playbook.title}`,
      labels: { [MANAGER_LABEL]: "true" },
    });
    const previous = this.trainsOf(pipelineId).find((train) => train.train!.station === stationId);
    const train = engine.newTrainRun({ id: `run_${shortId()}`, pipeline, station: stationId, jobs, managerAgentId: manager.id, now: nowIso() });
    await this.store.create(train);
    await this.store.mutate(pipelineId, (current) => engine.boardTrain(current, stationId, train.id, jobs.map((job) => job.id), nowIso()));
    // The station's previous train manager is done: one manager per station in the workspace.
    if (previous && previous.managerAgentId !== manager.id) await this.retireManager(previous.managerAgentId);
    for (const job of jobs) await this.noteHandoff(job, `On the "${stationId}" train (${train.id}) of "${pipeline.playbook.title}", with ${jobs.length} job(s).`);
    const started = this.store.get(train.id)!;
    await manager.send(singletonKickoff(started, engine.readySteps(started)));
    this.busyManagers.add(manager.id);
    this.tickAgain = true;
  }

  /**
   * Archives a previous train's manager, after its current turn: it is often still in the
   * complete_step call that ended its train, and archiving it there fails that call.
   */
  private async retireManager(agentId: string): Promise<void> {
    this.retiredManagers.add(agentId);
    if (!this.busyManagers.has(agentId)) await this.archiveStepAgent(agentId);
  }

  /**
   * Tells the runs whose jobs ride a train when it waits for a human (a gate or an ask), and
   * again when that is decided (or the train ends first): their managers pass it on where they
   * report. The decision stays with the train, in the Playbooks panel.
   */
  private async noticeTrainGates(): Promise<void> {
    for (const train of this.store.list()) {
      if (!train.train) continue;
      const pipeline = this.store.get(train.train.pipelineId);
      if (!pipeline) continue;
      const jobs = pipeline.jobs.filter((job) => job.riding.some((ride) => ride.runId === train.id));
      const where = `the "${train.train.station}" train (${train.id}) of "${pipeline.playbook.title}"`;
      for (const gate of train.gates) {
        const key = `${train.id}/${gate.id}`;
        // A gate its role decides is announced only if the role leaves it to a human.
        const pending = waitsForHuman(gate) && !isTerminal(train.status);
        if (pending === this.trainGates.has(key)) continue;
        let text: string;
        if (pending) {
          this.trainGates.add(key);
          const others = jobs.length > 1 ? ` (and ${jobs.length - 1} other job(s))` : "";
          text = `${where}, which carries your job${others}, waits for a human at ${gate.kind === "ask" ? "the ask of" : "gate"} ${gate.stepId}: ${gate.message} It is decided in the Playbooks panel (the "${pipeline.playbook.title}" card), not with resume: pass it on where you report. You are told when it is decided.`;
        } else {
          this.trainGates.delete(key);
          const comment = gate.comment ? `: "${gate.comment}"` : "";
          text = gate.status === "pending" ? `${gate.stepId} of ${where} no longer waits: the train ${train.status}.` : `${gate.stepId} of ${where} was decided: ${gate.status} by ${gate.decidedBy ?? "a human"}${comment}.`;
        }
        for (const runId of new Set(jobs.filter((job) => !job.detached).map((job) => job.fromRunId))) {
          const from = this.store.get(runId);
          if (!from || isTerminal(from.status)) continue;
          await this.enqueue(runId, [text]);
          await this.deliver(runId);
        }
        for (const job of jobs.filter((candidate) => candidate.status === "open")) await this.noteHandoff(job, pending ? `Waiting for a human at ${gate.stepId} of ${where} (Playbooks panel).` : `On ${where}.`);
      }
    }
  }

  /** Shows on the handing-off step where its job is. */
  private async noteHandoff(job: Job, text: string): Promise<void> {
    if (job.detached || !this.store.get(job.fromRunId)) return;
    const attemptId = handoffAttemptId(job.fromRunId, job.fromStepId, job.attempt);
    await this.store.mutate(job.fromRunId, (from) => {
      const attempt = from.steps[job.fromStepId]?.attempts.at(-1);
      if (attempt?.agentId === attemptId && from.steps[job.fromStepId]!.status === "running") attempt.lastMessage = text;
    });
  }

  /**
   * Trains that ended move their jobs on (next stations, out of the pipeline, back to the waiting
   * list, or failed); a pipeline that ended fails its open jobs and cancels its trains. The
   * hand-offs of jobs that ended are told.
   */
  private async endTrains(): Promise<void> {
    for (const train of this.store.list()) {
      if (!train.train || !isTerminal(train.status)) continue;
      const pipeline = this.store.get(train.train.pipelineId);
      if (!pipeline || !pipeline.jobs.some((job) => job.riding.some((ride) => ride.runId === train.id))) continue;
      const ended = await this.store.mutate(pipeline.id, (current) => engine.trainEnded(current, train, nowIso()));
      for (const job of ended) {
        // A job that passed every station yet failed (missing outputs) shipped: its hand-off is never retried.
        const shipped = job.status === "failed" && engine.stationsOf(pipeline).every((station) => job.passed.includes(station.id));
        await this.deliverJob(job, job.status === "settled" ? { outcome: job.outcome!, summary: job.summary ?? "", outputs: job.outputs } : { outcome: "failure", summary: job.summary ?? "", outputs: {} }, shipped);
      }
      for (const job of this.store.get(pipeline.id)!.jobs.filter((candidate) => candidate.status === "open")) {
        const next = job.waiting.map((place) => `"${place.station}"`).join(", ");
        if (next) await this.noteHandoff(job, `Waiting at ${next} of "${pipeline.playbook.title}".`);
      }
      this.tickAgain = true;
    }
    for (const pipeline of this.store.list()) {
      if (!isPipeline(pipeline) || !isTerminal(pipeline.status)) continue;
      for (const train of this.trainsOf(pipeline.id).filter((candidate) => !isTerminal(candidate.status))) {
        await this.cancelRun(train.id, `its pipeline ${pipeline.id} is ${pipeline.status}`, null).catch(() => undefined);
      }
      if (!pipeline.jobs.some((job) => job.status === "open")) continue;
      const ended = await this.store.mutate(pipeline.id, (current) => engine.failOpenJobs(current, `pipeline ${current.id} ${current.status}${current.failure ? `: ${current.failure}` : ""}`, nowIso()));
      for (const job of ended) await this.deliverJob(job, { outcome: "failure", summary: job.summary ?? "", outputs: {} });
    }
  }

  /** A job's result reaches the step that handed it off (which completes now, or on resume when its run is paused). */
  private async deliverJob(job: Job, result: { outcome: string; summary: string; outputs: Record<string, unknown> }, noRetry = false): Promise<void> {
    // A detached job's result stays on the pipeline: its run moved on long ago.
    if (job.detached || !this.store.get(job.fromRunId)) return;
    await this.finishHandoff(job.fromRunId, job.fromStepId, handoffAttemptId(job.fromRunId, job.fromStepId, job.attempt), result, noRetry);
  }

  private async finishHandoff(runId: string, stepId: string, attemptId: string, result: { outcome: string; summary: string; outputs: Record<string, unknown> }, noRetry = false): Promise<void> {
    this.clearTimeout(attemptId);
    const received = await this.store.mutate(runId, (current) => engine.receiveJobResult(current, stepId, attemptId, result, nowIso(), noRetry));
    if (received) await this.settleScripts(runId);
  }

  /** A hand-off step was canceled, reset or timed out: its job leaves the pipeline, and the trains carrying it are told. */
  private async withdrawHandoff(fromRunId: string, attemptId: string, reason: string): Promise<void> {
    this.clearTimeout(attemptId);
    const from = this.store.get(fromRunId);
    const attempt = from && Object.values(from.steps).flatMap((state) => state.attempts).find((candidate) => candidate.agentId === attemptId);
    if (!attempt?.job || !this.store.get(attempt.job.runId)) return;
    // A detached job belongs to the pipeline: nothing its run does withdraws it.
    if (this.store.get(attempt.job.runId)!.jobs.find((job) => job.id === attempt.job!.jobId)?.detached) return;
    const withdrawn = await this.store.mutate(attempt.job.runId, (current) => engine.withdrawJob(current, attempt.job!.jobId, reason, nowIso()));
    if (!withdrawn) return;
    for (const trainId of withdrawn.trains) {
      const train = this.store.get(trainId);
      if (!train) continue;
      await this.store.mutate(trainId, (current) => engine.mirrorJob(current, withdrawn.job));
      if (isTerminal(train.status)) continue;
      await this.enqueue(trainId, [`Job ${withdrawn.job.id} (from ${withdrawn.job.label}) was withdrawn: ${reason}. Leave it out of the rest of the train; it no longer needs settle_job.`]);
      await this.deliver(trainId);
    }
  }

  /** A train's manager settles one of its jobs: sets its outputs, or ends it (its hand-off is told at once). */
  async settleJob(managerId: string, runId: string, jobId: string, input: { outcome?: string | undefined; summary: string; outputs: Record<string, unknown> }): Promise<Run> {
    const train = this.ownedRun(managerId, runId);
    if (!train.train) throw new UserError(`run ${train.id} is not a train of a singleton pipeline: it carries no job`);
    if (isTerminal(train.status)) throw new UserError(`train ${train.id} is ${train.status}`);
    const pipelineId = train.train.pipelineId;
    if (!this.store.get(pipelineId)) throw new UserError(`the pipeline of train ${train.id} no longer exists`);
    const settled = await this.store.mutate(pipelineId, (current) => engine.settleJob(current, train.id, jobId, { ...input, now: nowIso() }));
    await this.store.mutate(train.id, (current) => engine.mirrorJob(current, settled.job));
    if (settled.ended) await this.deliverJob(settled.job, { outcome: settled.job.outcome!, summary: settled.job.summary ?? "", outputs: settled.job.outputs });
    return this.store.get(train.id)!;
  }

  /**
   * Checks a train step's `settle` output before the step completes: every entry must apply to
   * the pipeline as it is (tried on a copy). Returns the entries; throws with what is wrong.
   */
  private checkSettle(train: Run, step: Step, value: unknown): { results: engine.JobResult[]; pipeline: Run | null } {
    if (!train.train || !step.settle) return { results: [], pipeline: null };
    const pipeline = this.store.get(train.train.pipelineId);
    if (!pipeline) throw new UserError(`the pipeline of train ${train.id} no longer exists`);
    const where = `settle.output "${step.settle.output}" of "${step.id}"`;
    try {
      const results = engine.parseJobResults(typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));
      const copy = structuredClone(pipeline);
      for (const result of results) {
        if (result.outcome === undefined && Object.keys(result.outputs).length === 0) continue;
        engine.settleJob(copy, train.id, result.jobId, { ...result, now: nowIso() });
      }
      return { results, pipeline: copy };
    } catch (error) {
      throw new UserError(`${where}: ${errorText(error)}. Fix the entries (one per job id: \`{ outputs: {...}, outcome?, reason? }\`) and complete the step again.`);
    }
  }

  /**
   * A train step with `settle` completed: the plugin settles its jobs from that output, as
   * settle_job would (outputs set, or the job ended and its hand-off told). Returns problems.
   */
  private async applySettle(trainId: string, stepId: string, value?: unknown): Promise<string[]> {
    const train = this.store.get(trainId);
    if (!train?.train) return [];
    const step = engine.stepDef(train, stepId);
    if (!step.settle) return [];
    const state = train.steps[stepId]!;
    const attempt = state.attempts.at(-1);
    if (!attempt?.outcome || !engine.completesStep(step, attempt.outcome)) return [];
    const key = `${trainId}/${stepId}/${attempt.n}`;
    if (this.settledSteps.has(key)) return [];
    this.settledSteps.add(key);
    const raw = value ?? state.outputs?.[step.settle.output] ?? attempt.report?.outputs?.[step.settle.output];
    let results: engine.JobResult[];
    try {
      results = engine.parseJobResults(typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw));
    } catch (error) {
      return [`Could not settle jobs from "${stepId}" (${step.settle.output}): ${errorText(error)}. Call settle_job for them.`];
    }
    const problems: string[] = [];
    const settledIds: string[] = [];
    for (const result of results) {
      if (result.outcome === undefined && Object.keys(result.outputs).length === 0) continue;
      try {
        const settled = await this.store.mutate(train.train.pipelineId, (current) => engine.settleJob(current, trainId, result.jobId, { ...result, now: nowIso() }));
        await this.store.mutate(trainId, (current) => engine.mirrorJob(current, settled.job));
        if (settled.ended) await this.deliverJob(settled.job, { outcome: settled.job.outcome!, summary: settled.job.summary ?? "", outputs: settled.job.outputs });
        settledIds.push(`${result.jobId}${result.outcome ? ` (${result.outcome})` : ""}`);
      } catch (error) {
        problems.push(`Could not settle ${result.jobId} from "${stepId}": ${errorText(error)}. Call settle_job for it.`);
      }
    }
    if (settledIds.length > 0) problems.unshift(`The plugin settled from "${stepId}": ${settledIds.join(", ")}. Do not call settle_job for these again.`);
    return problems;
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
      if ((step.kind !== "script" && step.kind !== "handoff") || state.status !== "reported" || !isStepLive(this.store.get(runId)!, step.id)) continue;
      const attempt = state.attempts.at(-1)!;
      const kind = step.kind === "script" ? "script step" : "hand-off step";
      const report = attempt.report ?? { outcome: "failure", summary: `${step.script ?? step.handoff} ended without a result`, outputs: {} };
      let effects: engine.Effects;
      try {
        effects = await this.store.mutate(runId, (current) =>
          engine.completeStep(current, step.id, { outcome: report.outcome, summary: report.summary, outputs: report.outputs, now: nowIso() }),
        );
      } catch (error) {
        // Left reported: the manager decides with complete_step.
        await this.enqueue(runId, [`${kind} "${step.id}" attempt ${attempt.n} ended ${report.outcome} but could not be completed (${errorText(error)}). Call complete_step for it.`]);
        continue;
      }
      effects.notes.push(...(await this.applySettle(runId, step.id)));
      await this.applyEffects(runId, effects);
      await this.admitQueued();
      const after = this.store.get(runId)!;
      // A failure with retries left: the script already runs again, nothing for the manager yet.
      const again = after.steps[step.id]!;
      if ((again.status === "running" || again.status === "ready") && again.attempts.length > state.attempts.length) continue;
      const ready = engine.readySteps(after);
      await this.enqueue(runId, [
        `${kind} "${step.id}" attempt ${attempt.n} ended ${report.outcome}${step.kind === "script" ? ` after ${attempt.checks} check(s)` : ` (job of "${step.handoff}")`}: ${report.summary}${Object.keys(report.outputs).length ? ` Outputs: ${JSON.stringify(report.outputs)}.` : ""}`,
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
    if (step.kind === "handoff") throw new UserError(`step "${stepId}" is a hand-off step: the plugin hands its job to "${step.handoff}" and wakes you with the result`);
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

  private async stepAgentConfig(run: Run, step: Pick<Step, "id" | "agent">, tools = STEP_TOOL_NAMES) {
    const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    const provider = step.agent.provider ?? manager?.agent.provider ?? DEFAULT_PROVIDER;
    const model =
      step.agent.model ?? (manager?.agent.provider === provider ? manager?.agent.model ?? undefined : undefined) ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
    if (!model) throw new UserError(`step "${step.id}": no model for provider "${provider}"; set agent.model in the playbook`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (step.agent.mode) config.modeId = step.agent.mode;
    if (step.agent.thinking) config.thinkingOptionId = step.agent.thinking;
    return preapprove(config, provider, tools);
  }

  async completeStep(managerId: string, runId: string, stepId: string, input: { outcome: string; summary?: string; outputs?: Record<string, unknown> }): Promise<Run> {
    const run = this.ownedRun(managerId, runId);
    // A train step with `settle`: its entries must apply before the step may complete.
    const step = run.train ? engine.stepDef(run, stepId) : null;
    const settles = step?.settle && engine.completesStep(step, input.outcome) ? step.settle.output : null;
    const settleValue = settles ? (input.outputs?.[settles] ?? run.steps[stepId]?.attempts.at(-1)?.report?.outputs?.[settles]) : undefined;
    let pipeline: Run | null = null;
    if (settles && step) {
      const asText = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));
      const checked = this.checkSettle(run, step, settleValue);
      pipeline = checked.pipeline;
      // The manager's value replaces the report's: never with fewer entries.
      const reported = run.steps[stepId]?.attempts.at(-1)?.report?.outputs?.[settles];
      if (input.outputs?.[settles] !== undefined && reported !== undefined) {
        const given = new Set(checked.results.map((result) => result.jobId));
        const lost = engine.parseJobResults(asText(reported)).map((result) => result.jobId).filter((jobId) => !given.has(jobId));
        if (lost.length > 0) {
          throw new UserError(`"${stepId}" reported ${settles} for ${lost.length + given.size} job(s), and the value you passed leaves out ${lost.join(", ")}. Pass the same entries or correct them, never empty them; or leave ${settles} out of complete_step: the plugin takes it from the report.`);
        }
      }
    }
    if (run.train) {
      // Before the train's last step completes it: no job may leave the pipeline missing an output.
      const train = structuredClone(run);
      const trial = structuredClone(this.store.get(run.train.pipelineId) ?? null);
      if (trial) {
        if (pipeline) Object.assign(trial, pipeline);
        const probe: Parameters<typeof engine.completeStep>[2] = { outcome: input.outcome, now: nowIso() };
        if (input.outputs !== undefined) probe.outputs = input.outputs;
        let completes = false;
        try {
          engine.completeStep(train, stepId, probe);
          completes = train.status === "completed";
        } catch {
          // The real call below reports why.
        }
        const missing = completes ? engine.jobsMissingOutputs(trial, run) : [];
        if (missing.length > 0) {
          throw new UserError(`"${stepId}" would end the train with jobs missing outputs they need to leave the pipeline: ${missing.join("; ")}. Set them first (settle_job without an outcome, or the step's settle output) and complete the step again.`);
        }
      }
    }
    const effects = await this.store.mutate(run.id, (current) => {
      const args: Parameters<typeof engine.completeStep>[2] = { outcome: input.outcome, now: nowIso() };
      if (input.summary !== undefined) args.summary = input.summary;
      if (input.outputs !== undefined) args.outputs = input.outputs;
      return engine.completeStep(current, stepId, args);
    });
    if (settles) await this.enqueue(run.id, await this.applySettle(run.id, stepId, settleValue));
    await this.applyEffects(run.id, effects);
    await this.admitQueued(run.id);
    return this.store.get(run.id)!;
  }

  async requestGate(managerId: string, runId: string, stepId: string, summary: string, details: string) {
    const run = this.ownedRun(managerId, runId);
    const result = await this.store.mutate(run.id, (current) => engine.requestGate(current, stepId, summary, nowIso(), details));
    // A train's gate is announced to the runs whose jobs it carries; a role decider starts.
    await this.tick();
    return this.store.get(run.id)!.gates.find((gate) => gate.id === result.id) ?? result;
  }

  /** A gate decision from the panel (wakes the manager) or from chat via resume (does not). */
  async decideGate(runId: string, gateId: string, decision: engine.GateDecision): Promise<{ alreadyDecided: boolean; gate: Run["gates"][number] }> {
    const result = await this.store.mutate(runId, (current) => engine.decideGate(current, gateId, decision));
    // An ask choice with an outcome may complete a train step with `settle`.
    if (!result.alreadyDecided) {
      const problems = await this.applySettle(runId, result.gate.stepId);
      if (problems.length > 0) await this.enqueue(runId, problems);
    }
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
    if (by && !isPipeline(this.store.get(runId)!)) {
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
    if (isAgentlessAttempt(attempt.agentId)) throw new UserError(`step "${stepId}" is a ${isScriptAttempt(attempt.agentId) ? "script" : "hand-off"} step: there is no agent to nudge`);
    if (!isStepLive(run, stepId)) throw new UserError(`step "${stepId}" can no longer change: run ${run.id} is ${run.status}`);
    if (state.status === "reported") {
      // The agent works again: its next turn end reports again (after a timeout, its report replaces the timeout failure).
      await this.store.mutate(runId, (current) => engine.reopenAttempt(current, stepId, nowIso()));
      this.armTimeout(this.store.get(runId)!, stepId);
    } else if (state.status !== "running") {
      const ask = run.gates.find((gate) => gate.kind === "ask" && gate.stepId === stepId && gate.status === "pending");
      if (ask) throw new UserError(`step "${stepId}" asks (${ask.id}): answer it through its ask with resume, never with nudge_step`);
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
   * Same workspace and branch, unless the workspace is gone or busy: then `workspaceId` names another workspace of the project to move the run to. With `takeOver`, that agent (the restart_run caller, in the
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
    workspaceId?: string,
  ): Promise<{ run: Run; newManager: boolean }> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    const blocker = restartBlocker(run, stepId);
    if (blocker) throw new UserError(blocker);
    if (isPipeline(run)) throw new UserError(`run ${run.id} is a singleton pipeline: it is not restarted; the next hand-off starts a new one`);
    if (run.train) throw new UserError(`run ${run.id} is a train of pipeline ${run.train.pipelineId}: a failed train's jobs ride the station's next train (or fail, past its retries)`);
    const origin = await this.workspaceOf(run.workspaceId);
    const active = (inWorkspace: string) => this.store.list().find((other) => other.id !== run.id && other.workspaceId === inWorkspace && isActive(other));
    const busy = active(run.workspaceId);
    let move: { id: string; dir: string; branch: string | null } | null = null;
    if (workspaceId && workspaceId !== run.workspaceId) {
      const target = await this.workspaceOf(workspaceId);
      if (!target) throw new UserError(`workspace ${workspaceId} does not exist (list_workspaces shows the ones that do; create_workspace makes one)`);
      if (target.projectId !== run.projectId) throw new UserError(`workspace ${workspaceId} belongs to another project than run ${run.id} (${run.projectId}): pick a workspace of the same project`);
      const there = active(workspaceId);
      if (there) throw new UserError(`workspace ${workspaceId} already has an active run (${there.id}); one active run per workspace`);
      const dir = target.workspaceDirectory;
      if (!dir) throw new UserError(`workspace ${workspaceId} has no directory`);
      move = { id: workspaceId, dir, branch: (await currentRef(dir)) ?? run.branch };
    } else if (!origin || busy) {
      const why = !origin ? `its workspace (${run.workspaceId}, ${run.workspaceDir}) no longer exists` : `its workspace (${run.workspaceId}) has another active run (${busy!.id}); one active run per workspace`;
      throw new UserError(`run ${run.id} cannot restart in place: ${why}. Pass workspaceId (an existing workspace of the same project with no active run; create_workspace makes one) to restart it there with its completed steps kept${busy ? `, or wait for ${busy.id} to end` : ""}.`);
    }
    const homeId = move?.id ?? run.workspaceId;
    if (takeOver && takeOver.workspaceId !== homeId) {
      throw new UserError(`run ${run.id} will be in workspace ${homeId}: only an agent of that workspace can take it over; omit takeOver and a manager is found for it`);
    }
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
    const manager = takeOver || move ? null : await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    // A run moved to another workspace always gets a manager there.
    const managerGone = !takeOver && (Boolean(move) || !manager || Boolean(manager.agent.archivedAt));
    // The original manager was archived (which also archives its runs): a new one takes over.
    // It is created without a prompt, so it cannot look for the run before the run is its own.
    const replacement = managerGone ? await this.createReplacementManager(homeId, run.playbook) : null;
    const effects = await this.store.mutate(runId, (current) => {
      const fx = engine.restartRun(current, stepId, { comment, by, now: nowIso() });
      if (move) {
        engine.moveRun(current, move, nowIso());
      }
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
      `Completed steps before it keep their outputs (get_run with view "full" shows them). Carry on as usual: start ${ready.length === 1 ? "the ready step" : "the ready steps"} with start_step (or request_gate for a gate).`,
    ];
    if (takeOver) {
      // The caller reads the ready steps in the tool result; nothing to wake.
    } else if (replacement) {
      const current = this.store.get(runId)!;
      await replacement.send(`${managerTakeover(current, ready, move ? `restarted in workspace ${move.id} (${move.dir}), moved from ${run.workspaceId}` : "restarted after its previous manager was archived")}\n\n[playbooks] ${lines.join(" ")}`);
    } else {
      await this.enqueue(runId, lines);
      await this.deliver(runId);
    }
    return { run: this.store.get(runId)!, newManager: replacement !== null || (takeOver !== undefined && takeOver.id !== run.managerAgentId) };
  }

  /** The workspace, or null when it no longer exists. */
  private async workspaceOf(workspaceId: string) {
    return (await this.api().workspaces.ref(workspaceId).refresh().catch(() => null)) ?? null;
  }

  /** A new Playbook Manager in the run's workspace, created without a prompt so it cannot look for the run before the run is its own. */
  private async createReplacementManager(workspaceId: string, playbook: Playbook) {
    return this.api()
      .workspaces.ref(workspaceId)
      .agents.create({
        config: this.managerConfig(playbook),
        title: `Playbook Manager · ${playbook.title}`,
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
    const replacement = await this.createReplacementManager(run.workspaceId, run.playbook).catch((error: unknown) => {
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
      `[playbooks] ${current.id} · The previous manager (agent ${previous}) was archived because the agent that created it (${parentId}) was archived. You take the run over from where it is: completed steps keep their outputs (get_run with view "full" shows them).`,
      running.length > 0
        ? `Steps that were running had their agents archived too: ${running.join(", ")}. When they show as ended (lost), call complete_step with "failure" to start them again (a lost attempt does not count as a retry), unless their report or the worktree shows the work is done.`
        : "",
      reported.length > 0
        ? `Steps waiting for complete_step: ${reported.join(", ")}. Read them with get_run (view "full" for their reports); a step that ended (lost) without a report had its agent archived: complete it with "failure" to start it again, unless the work is done.`
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

  /** The outcomes the agent's current step accepts (empty when it is no step's attempt). */
  outcomesOf(agentId: string): string[] {
    const found = this.stepRunOf(agentId);
    return found ? engine.stepDef(found.run, found.stepId).outcomes : [];
  }

  async report(agentId: string, report: { outcome: string; summary: string; outputs: Record<string, unknown> }, repairNote: string | null = null): Promise<string> {
    const found = this.stepRunOf(agentId);
    if (!found) throw new UserError("you are not the current attempt of any playbook step");
    this.checkReportedOutcomes(found.run, found.stepId, report.outputs);
    await this.store.mutate(found.run.id, (current) => {
      engine.recordReport(current, agentId, report, nowIso());
      if (repairNote) engine.noteEvent(current, "report_repaired", found.stepId, repairNote, nowIso());
    });
    await this.onLateReport(found.run.id, found.stepId, agentId);
    return found.stepId;
  }

  /**
   * A step reported an outcome whose transition is an ask: its ask opens at once, as for a script,
   * without waiting for complete_step. Returns the effects' notes, or null when the report is no ask.
   */
  private async openReportedAsk(runId: string, stepId: string): Promise<string[] | null> {
    const run = this.store.get(runId);
    const report = run?.steps[stepId]?.attempts.at(-1)?.report;
    if (!run || !report || run.steps[stepId]!.status !== "reported" || isPaused(run)) return null;
    if (engine.defaultTransition(engine.stepDef(run, stepId), report.outcome).kind !== "ask") return null;
    let effects: engine.Effects;
    try {
      effects = await this.store.mutate(runId, (current) => engine.completeStep(current, stepId, { outcome: report.outcome, summary: report.summary, now: nowIso() }));
    } catch {
      return null;
    }
    await this.applyEffects(runId, effects);
    return [...effects.notes, `Its ask is open: a human answers it (the panel, or resume). Do not call complete_step or nudge_step for "${stepId}".`];
  }

  /** A train step's `settle` output may only name outcomes the singleton has: refused at report time, so the agent corrects it. */
  private checkReportedOutcomes(run: Run, stepId: string, outputs: Record<string, unknown>): void {
    const step = run.train ? engine.stepDef(run, stepId) : null;
    if (!run.train || !step?.settle) return;
    const raw = outputs[step.settle.output];
    const pipeline = this.store.get(run.train.pipelineId);
    if (!pipeline || raw === undefined || raw === null) return;
    let results: engine.JobResult[];
    try {
      results = engine.parseJobResults(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    const allowed = pipeline.playbook.outcomes;
    for (const result of results) {
      if (result.outcome !== undefined && !allowed.includes(result.outcome)) {
        throw new UserError(`${step.settle.output}: job ${result.jobId} has outcome "${result.outcome}", which is not an outcome of "${pipeline.playbook.id}" (use ${allowed.join(", ")}, or no outcome key for a job that keeps riding). Fix it and call report_step_result again.`);
      }
    }
  }

  /**
   * A report for an attempt whose turn already ended (after the reminder, say, the agent ended its
   * turn waiting, then a background task woke it). Its next turn end is ignored as the step is no
   * longer running, so the manager is woken here, as if the turn had ended with the report.
   */
  private async onLateReport(runId: string, stepId: string, agentId: string): Promise<void> {
    const run = this.store.get(runId)!;
    const attempt = run.steps[stepId]!.attempts.at(-1)!;
    if (run.steps[stepId]!.status !== "reported" || attempt.agentId !== agentId || !attempt.report) return;
    const violation = attempt.readonlySnapshot !== null ? snapshotDiff(attempt.readonlySnapshot, await checkoutSnapshot(run.workspaceDir)) : null;
    if (violation) await this.store.mutate(runId, (current) => engine.markReadonlyViolation(current, stepId, violation, nowIso()));
    const asked = violation ? null : await this.openReportedAsk(runId, stepId);
    await this.enqueue(runId, [
      `${reportedLine(stepId, attempt.n, this.store.get(runId)!.steps[stepId]!.attempts.at(-1)!.report!)} It reported after its turn had ended.`,
      violation ? `Readonly check failed (${violation}); complete it with "failure".` : "",
      ...(asked ?? [`Call complete_step for "${stepId}".`]),
    ].filter(Boolean));
    await this.deliver(runId);
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
      ? `${reportedLine(ended.stepId, ended.attempt.n, report)}${turnEnd === "timeout" ? " If its work is in fact done, nudge_step it to report: its report replaces the timeout failure. Or call complete_step with the outputs from its conversation." : ""}`
      : ended.attempt.reminded
        ? `${head} ended (${turnEnd}) without reporting, even after the plugin asked it to.${lastMessage ? ` Last message: ${lastMessage.slice(0, 1500)}` : ""} If it is still waiting on something, nudge_step it later. If it could not report (e.g. report_step_result "not found"), check the outputs it gave in its conversation and call complete_step with them.`
        : `${head} ended (${turnEnd}) without reporting.${lastMessage ? ` Last message: ${lastMessage.slice(0, 1500)}` : ""} Use nudge_step to ask it to report, or complete_step.`;
    const asked = report && !violation ? await this.openReportedAsk(runId, ended.stepId) : null;
    const others = Object.entries(this.store.get(runId)!.steps)
      .filter(([, state]) => state.status === "running")
      .map(([id]) => id);
    await this.enqueue(runId, [
      line,
      violation ? `Readonly check failed (${violation}); complete it with "failure".` : "",
      ...(asked ?? [`Call complete_step for "${ended.stepId}".`]),
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
    const decider = this.deciderOf(agentId);
    if (decider) return this.onDeciderTurnEnded(decider.run.id, decider.gate.id, agentId, outcome);
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
    const at = Date.now();
    this.recentArchives = [...this.recentArchives.filter((entry) => at - entry.at < 5000), { id: agentId, at }];
    this.pendingHandoffs.delete(agentId);
    await this.bus.dropOwner(agentId);
    const decider = this.deciderOf(agentId);
    if (decider) {
      this.stoppedDeciders.add(agentId);
      await this.escalate(decider.run.id, decider.gate.id, "its agent was archived before deciding");
      return;
    }
    const active = this.activeRunOfManager(agentId);
    if (active) {
      const adopted = parentAgentId !== null && (await this.archivedWithParent(parentAgentId)) && (await this.adoptOrphanedRun(active.id, parentAgentId));
      if (!adopted) await this.failManagerLost(active.id, "manager lost (archived)", await this.archiveCause(agentId, parentAgentId, active.workspaceId), parentAgentId);
    }
    // Archiving the manager archives its runs (an adopted one is no longer its own; another active one was just failed).
    for (const run of this.runsOfManager(agentId)) {
      if (!run.archivedAt) await this.archiveRun(run.id).catch(() => undefined);
    }
    const step = this.stepRunOf(agentId);
    if (step) await this.onStepTurnEnded(step.run.id, agentId, "lost");
  }

  /** Agents archived in the last few seconds, to tell a batch archive from a single one. */
  private recentArchives: Array<{ id: string; at: number }> = [];

  /**
   * What the plugin can tell about an archive: the host's hook names the agent and its parent,
   * not who called it (an agent, the UI, a workspace archive or a cleanup), so the cause lists
   * the evidence: a cascade from an archived parent, a workspace that is gone, and the other
   * managers archived within the same couple of seconds.
   */
  private async archiveCause(agentId: string, parentAgentId: string | null, workspaceId: string): Promise<string> {
    const parts = [`manager ${agentId} was archived; the host does not say by whom (an agent, the UI, a workspace archive or a cleanup)`];
    if (parentAgentId) parts.push(`its parent ${parentAgentId} is ${(await this.archivedWithParent(parentAgentId)) ? "archived too" : "still active"}`);
    parts.push(`workspace ${workspaceId} ${(await this.workspaceOf(workspaceId)) ? "still exists" : "is gone"}`);
    const now = Date.now();
    const together = this.recentArchives.filter((entry) => entry.id !== agentId && now - entry.at < 2000 && this.runsOfManager(entry.id).length > 0).map((entry) => entry.id);
    if (together.length > 0) parts.push(`other managers archived within 2 s: ${together.join(", ")} (one batch, probably one source)`);
    return parts.join("; ");
  }

  /**
   * Fails a run whose manager is gone, records why in its history, and tells the agent that
   * created the manager (the plugin has no push notification or Slack facility; the run's
   * failure shows in the panel and in list_runs).
   */
  private async failManagerLost(runId: string, reason: string, cause: string, notify: string | null): Promise<void> {
    const before = this.store.get(runId)!;
    const reached = Object.entries(before.steps).filter(([, state]) => state.status === "running" || state.status === "reported" || state.status === "waiting").map(([id]) => id);
    await this.store.mutate(runId, (current) => engine.noteEvent(current, "manager_archived", null, cause, nowIso()));
    await this.failRun(runId, reason);
    if (!notify) return;
    const run = this.store.get(runId)!;
    const restartable = run.playbook.steps.filter((step) => restartBlocker(run, step.id) === null).map((step) => step.id);
    const parent = await this.api().agents.ref(notify).refresh().catch(() => null);
    if (!parent || parent.agent.archivedAt) return;
    await this.api().agents.ref(notify).send(managerLostNotice(run, reached, restartable, cause)).catch((error: unknown) => console.error(`[playbooks] could not tell agent ${notify} that run ${runId} lost its manager:`, errorText(error)));
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
    if (!attempt || isAgentlessAttempt(attempt.agentId) || attempt.silenceReminded || run.steps[stepId]!.status !== "running") return;
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
    if (isHandoffAttempt(agentId)) {
      await this.withdrawHandoff(runId, agentId, `its hand-off step timed out after ${Math.round(timeoutMs / 60000)} min`);
      await this.finishHandoff(runId, stepId, agentId, { outcome: "failure", summary: `timed out after ${Math.round(timeoutMs / 60000)} min waiting for its job`, outputs: {} });
      return;
    }
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
    const run = await this.startPlaybook({ id: agentId, workspaceId, cwd: agent.cwd }, playbook.id, inputs, { playbook });
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
    if (playbook.singleton) {
      const run = await this.startPipeline(workspaceDir, workspace.projectId, playbook);
      return { status: "started" as const, workspaceId: run.workspaceId, managerAgentId: run.managerAgentId, runId: run.id, queued: false };
    }
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
    return this.startInNewWorkspace(workspaceDir, playbook, resolved.inputs);
  }

  /** A new workspace branched off this one's current ref, with a new Playbook Manager that starts the run there. */
  private async startInNewWorkspace(workspaceDir: string, playbook: Playbook, inputs: Record<string, VarValue>) {
    const id = shortId();
    const runId = `run_${id}`;
    const branch = `playbooks/${playbook.id}-${id}`;
    const base = (await currentRef(workspaceDir)) ?? undefined;
    const headline = String(inputs.request ?? Object.values(inputs)[0] ?? "").slice(0, 60);
    const created = await this.api().workspaces.create({
      title: `${playbook.title}${headline ? `: ${headline}` : ""}`,
      source: { kind: "worktree", cwd: workspaceDir, action: "branch-off", branchName: branch, ...(base ? { refName: base } : {}) },
    });
    this.reservations.set(created.id, { runId, branch, playbook, inputs });
    const manager = await created.agents.create({
      config: this.managerConfig(playbook),
      title: `Playbook Manager · ${playbook.title}`,
      labels: { [MANAGER_LABEL]: "true" },
      prompt: managerKickoff(playbook, inputs),
    });
    return { status: "started" as const, workspaceId: created.id, managerAgentId: manager.id, runId };
  }

  /**
   * start_playbook with `newWorkspace`: the run gets its own workspace and its own Playbook
   * Manager, so any manager can start one, a train's included (rework for an ejected job).
   */
  async startPlaybookElsewhere(manager: { cwd: string; workspaceId: string | null }, playbookId: string, inputs: Record<string, unknown>) {
    let workspaceDir = manager.cwd;
    let projectId: string | null = null;
    if (manager.workspaceId) {
      const workspace = await this.api().workspaces.ref(manager.workspaceId).refresh();
      if (workspace) {
        workspaceDir = workspace.workspaceDirectory ?? manager.cwd;
        projectId = workspace.projectId;
      }
    }
    const loaded = await loadPlaybooks(workspaceDir);
    const entry = loaded.entries.find((candidate) => candidate.id === playbookId);
    if (!entry) throw new UserError(`no playbook "${playbookId}" in this workspace (have: ${loaded.entries.map((e) => e.id).join(", ") || "none"})`);
    if (!entry.playbook) throw new UserError(`playbook "${playbookId}" is invalid:\n${entry.errors.join("\n")}`);
    const playbook = entry.playbook;
    if (playbook.singleton) throw new UserError(`"${playbookId}" is a singleton: it runs in its own pipeline workspace; start it without newWorkspace`);
    const resolved = engine.resolveRunInputs(playbook, inputs);
    if (!resolved.ok) throw new UserError(resolved.errors.join("; "));
    if (projectId) this.checkConcurrency(playbook, projectId);
    return this.startInNewWorkspace(workspaceDir, playbook, resolved.inputs);
  }

  hasReservation(workspaceId: string | null): boolean {
    return workspaceId !== null && this.reservations.has(workspaceId);
  }
}
