import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The daemon API handed to plugin handlers (typed via the SDK, so the build needs no @getpaseo/client). */
type PaseoApi = PluginHandlerContext["paseo"];
import type { AdmissionStatus, ScriptOutput } from "../shared/types";
import type { AgentSettings, AgentTarget, Attempt, FanoutChild as FanoutChildState, Gate, Job, Playbook, Run, RunWorktree, Step, VarValue } from "../shared/types";
import { addUsage } from "../shared/types";
import { UsageLedger } from "./usage-ledger";
import { analyze, type Analytics } from "../shared/analytics";
import {
  SCRIPT_NOT_YET,
  attemptTimeoutMs,
  handoffAttemptId,
  isActive,
  isAgentlessAttempt,
  isManagerless,
  isPipeline,
  isFanoutAttempt,
  fanoutAttemptId,
  isHandoffAttempt,
  isPaused,
  isScriptAttempt,
  isStepLive,
  isTerminal,
  restartBlocker,
  scriptAttemptId,
} from "../shared/types";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults";
import { isQuotaError, isQuotaMessage } from "./quota";
import { UsageCache, usageBlock, type UsageBlock, type UsageSnapshot } from "./usage";
import * as engine from "./engine";
import { ADMISSION_TIMEOUT_MS, admissionInput, readAdmission } from "./admission";
import { checkoutSnapshot, currentRef, defaultBranch, fastForward, freshRef, removedGitlinks, snapshotDiff } from "./git";
import { workspaceTitle } from "../shared/workspace-name";
import { createWorktree, dirtyPaths, linkedSubmodules, listWorktreeDirs, pruneWorktrees, removeWorktree, repoOfWorktree, worktreeBranch, worktreePath } from "./worktree";
import { chooseDefinition } from "./fresh";
import { runWorktreeTeardown } from "./teardown";
import { loadPlaybooks, loadSidekick } from "./loader";
import { findEntry } from "../shared/repos";

/** The entry a stored or typed playbook id means: bare ids resolve to the one namespaced entry (and the reverse); ambiguity or absence gives undefined. */
function lookup(entries: Parameters<typeof findEntry>[0], ref: string) {
  const found = findEntry(entries, ref);
  return "entry" in found ? found.entry : undefined;
}
import { DEFAULT_SIDEKICK_RESTART_TOKENS, DEFAULT_SIDEKICK_SUBAGENT, SIDEKICK_LABEL, SIDEKICK_PROJECT_LABEL, sidekickGateSweep, sidekickHandoffRequest, sidekickKickoff, SIDEKICK_PASEO_TOOLS, SIDEKICK_PLUGIN_TOOLS, SidekickRegistry, sidekickPrompt, sidekickTitle } from "./sidekick";
import { BusError, EventBus, globToRegExp, type BusEvent, type Notifier, type Subscription } from "./bus";
import { OversightProducer, registerOversightTypes } from "./oversight-events";
import { JOB_TYPES, publicJobEvents } from "./job-events";
import { gateListing, listAttention, type GateFilter } from "./overseer";
import { gateChatPrompt, managerLostNotice, gateDeciderPrompt, gateDeciderSystemPrompt, gateDecisionReminder, managerAfterRestart, managerKickoff, managerTakeover, reportReminder, resumeAfterRestart, silenceReminder, singletonKickoff, stepSystemPrompt, withPreamble } from "./prompts";
import { askHumanText, choicesOfGate, waitsForHuman } from "../shared/gates";
import { StaleSessions } from "./stale-sessions";
import type { RunStore } from "./store";
import { holdsBlock, planAdmissions, slotHolders } from "../shared/slots";

export class UserError extends Error {}

/** How often a batch's manager is reminded of detached jobs without a follow-up before the plugin stops holding it. */
const FOLLOW_UP_REMINDERS = 3;

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
  "archive_run",
  "requeue_job",
  "validate_playbooks",
  "settle_job",
  "record_followup",
];
export const STEP_TOOL_NAMES = ["report_step_result"];
/** A run with no manager also lets its step agents put a human gate's question in their conversation. */
export const MANAGERLESS_STEP_TOOL_NAMES = [...STEP_TOOL_NAMES, "answer_gate"];
export const GATE_TOOL_NAMES = ["report_gate_decision"];

type AgentConfig = { provider: string; modeId?: string; thinkingOptionId?: string; options?: { allowedTools: string[] } };

/** Pre-approves our own tools so unattended agents in `default` mode are not blocked on them. */
/** A model the manager picks for one step attempt: `provider/model`, and optionally a thinking option. */
export interface ModelChoice {
  target: string;
  thinking?: string;
}

/** Splits `provider/model` at its first slash (model ids may contain more). */
function splitTarget(entry: string): [string, string] {
  const at = entry.indexOf("/");
  return at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
}

/** A target on `provider/model` that keeps `base`'s mode and thinking only when it is on the same provider (they are provider-specific). */
function inheritTarget(base: AgentTarget, provider: string, model: string): AgentTarget {
  const same = base.provider === provider;
  return { provider, model, ...(same && base.mode ? { mode: base.mode } : {}), ...(same && base.thinking ? { thinking: base.thinking } : {}) };
}

function preapprove(config: AgentConfig, provider: string, tools: string[]): AgentConfig {
  if (provider === "claude") config.options = { allowedTools: tools.map((tool) => `mcp__paseo__${tool}`) };
  return config;
}

const MANAGER_LABEL = "playbooks/manager";
export const STEP_LABEL = "playbooks/step";
export const RUN_LABEL = "playbooks/run";
/** On a gate's role decider agent: the gate id. */
export const GATE_LABEL = "playbooks/gate";

/** `90m`-style text for a delay in ms. */
function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

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

interface Violation {
  kind: "readonly" | "isolation" | "gitlink";
  detail: string;
}

function violationLine(violation: Violation): string {
  if (violation.kind === "gitlink") {
    return `Gitlink guard failed: the run's branch deletes submodule entries (${violation.detail}); complete the step with "failure" and have it restore them (\`git restore --staged --worktree --source=<base> -- <path>\`, or \`git checkout <base> -- <path>\`). Set \`isolation.allow_gitlink_removal: true\` if the removal is intended.`;
  }
  return violation.kind === "readonly"
    ? `Readonly check failed (${violation.detail}); complete it with "failure".`
    : `Isolation guard failed: the original workspace checkout changed (${violation.detail}) although the run works in its worktree; complete the step with "failure" and nudge or restart it so it works only in the worktree.`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A start refused only because the playbook's `concurrency` slots are taken: a fan-out waits and tries again. */
class ConcurrencyError extends UserError {}

/** A fan-out child whose run does not exist this long after its start is given up on. */
const FANOUT_START_TIMEOUT_MS = 10 * 60 * 1000;

interface Reservation {
  runId: string;
  /** null: the workspace's current branch, read when the run is created. */
  branch: string | null;
  playbook: Playbook;
  inputs: Record<string, VarValue>;
  /** The plugin created the workspace (newWorkspace), so its run may archive it. */
  created?: boolean;
  /** Set when a fan-out step started the run. */
  parent?: Run["parent"];
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
    PLAYBOOK_WORKSPACE: engine.workDir(run),
  };
  if (run.worktree) env.PLAYBOOK_ORIGINAL_WORKSPACE = run.workspaceDir;
  if (feedback) env.PLAYBOOK_FEEDBACK = feedback;
  // A singleton run's open jobs, as {{ run.jobs }} gives them to prompts.
  if (run.playbook.singleton) env.PLAYBOOK_JOBS = JSON.stringify(engine.openJobs(run));
  for (const [name, input] of Object.entries(attempt.inputs)) {
    env[`PLAYBOOK_INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = input.value === "(none)" ? "" : input.value;
  }
  return env;
}

/** How many ended checks of a running script attempt the panel can show. */
const SCRIPT_CHECKS_KEPT = 5;

/** Least time between the end of a check and the start of one an event asks for (ADR 2026-11-12-script-wake-on). */
export const DEFAULT_WAKE_GAP_MS = 5000;

/** A script attempt that listens for events (`script.wake_on`): who it is, what it matches, and its coalescing state. */
interface Waker {
  runId: string;
  stepId: string;
  rules: Array<{ types: RegExp[]; filter: Array<[string, string | number | boolean]> }>;
  /** A check is in flight, or has ended and its follow-up is not scheduled yet: an event only sets `dirty`. */
  busy: boolean;
  /** An event matched while busy: one more check runs once it is over. First type that did, for the sheet. */
  dirty: string | null;
  /** A check an event asked for waits out the gap in `slot.next`. */
  gapWait: boolean;
  /** ms since epoch the last check ended; 0 before the first. */
  endedAt: number;
}

/** A stage's admission check (`queue.admit`): its coalescing state like a Waker's, its timers, and what the panel shows. */
interface Admission {
  pipelineId: string;
  stageId: string;
  /** A check is in flight, or has ended and its follow-up is not scheduled yet: an event only sets `dirty`. */
  busy: boolean;
  /** An event matched while busy (first type that did; "retry" skips the gap): one more check runs once it is over. */
  dirty: string | null;
  /** A check an event asked for waits out the gap in `next`. */
  gapWait: boolean;
  /** ms since epoch the last check ended; 0 before the first. */
  endedAt: number;
  child: ChildProcess | null;
  /** The poll timer, or the wake-up waiting out the gap. */
  next: ReturnType<typeof setTimeout> | null;
  status: AdmissionStatus;
}

interface ScriptLive {
  /** ISO time the running check started; null between checks. */
  runningSince: string | null;
  /** What started the running check: "first", "poll" or "event:<type>". */
  trigger: string | null;
  /** Latest output of the running check (stdout and stderr, in arrival order), bounded by SCRIPT_OUTPUT_MAX. */
  tail: string;
  /** Ended checks, oldest first. */
  checks: ScriptOutput["checks"];
}

function idleAdmission(): AdmissionStatus {
  return { running: false, since: null, trigger: null, tail: "", nextCheckAt: null, checks: 0, lastCheckAt: null, lastOutcome: null, error: null, warnings: [] };
}

function formatMinutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${+(ms / 1000).toFixed(1)} s`;
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

/** What a failed turn says went wrong: its error entries, else its last assistant text. Defensive: entry shapes vary by provider. */
function failureText(entries: ReadonlyArray<{ item?: Record<string, unknown> }>): string {
  const errors: string[] = [];
  for (const { item } of entries) {
    if (!item || typeof item.type !== "string" || !/error|fail/i.test(item.type)) continue;
    for (const key of ["message", "text", "error", "detail"]) {
      const value = item[key];
      if (typeof value === "string") errors.push(value);
      else if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") errors.push((value as { message: string }).message);
    }
  }
  if (errors.length > 0) return errors.join("\n").slice(-4000);
  return lastAssistantText(entries as never) ?? "";
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
  /** Managers that handled a wake-up since they were last checked for compaction. */
  private readonly wokenManagers = new Set<string>();
  /** Managers of a run where a gate was decided since they were last checked for compaction. */
  private readonly gateManagers = new Set<string>();
  /**
   * Managers of a stage's previous batch: archived once their turn ends, and never woken
   * again (sending to an archived agent brings it back).
   */
  private readonly retiredManagers = new Set<string>();
  /** Managers whose retirement waits for the follow-ups of their batch's detached jobs (manager id -> batch run id). */
  private readonly heldManagers = new Map<string, string>();
  /** Reminders sent to a batch's manager about detached jobs without a follow-up (batch run id -> count). */
  private readonly followUpReminders = new Map<string, number>();
  /** Batch gates announced to the runs of their jobs, as "<batchId>/<gateId>". */
  private readonly batchGates = new Set<string>();
  /** Batch step attempts whose `settle` output was applied, as "<batchId>/<stepId>/<attempt>". */
  private readonly settledSteps = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Silence checks of running agent steps, by agent id. */
  private readonly watches = new Map<string, ReturnType<typeof setTimeout>>();
  /** Start reserves a run id and playbook snapshot for the worktree it creates. */
  private readonly reservations = new Map<string, Reservation[]>();
  /** Where isolated runs' worktrees live: `<plugin data>/worktrees/<runId>`. */
  readonly worktreesDir: string;
  /** Worktrees being created, which the orphan sweep must not touch. */
  private readonly creatingWorktrees = new Set<string>();
  /** Runs started from the panel for a busy agent: agent id → run id, delivered when its turn ends. */
  private readonly pendingHandoffs = new Map<string, string>();
  /** Script steps in flight, by attempt id: the running check, or the timer of the next one. */
  private readonly scripts = new Map<string, { child: ChildProcess | null; next: ReturnType<typeof setTimeout> | null }>();
  /** What a script attempt's checks printed, by attempt id: the running check's live tail and the last few checks. In memory only; dropped when the attempt stops. */
  private readonly scriptLive = new Map<string, ScriptLive>();
  /** Admission checks (`queue.admit`) of the stages that have waiting jobs, by `<pipeline run>/<stage>`. */
  private readonly admissions = new Map<string, Admission>();
  /** Script attempts with `wake_on`, by attempt id. One bus listener serves all of them. */
  private readonly wakers = new Map<string, Waker>();
  /** Feedback a script attempt started with (after a goto), passed to each of its checks. */
  private readonly scriptFeedback = new Map<string, string>();
  /** Pipelines being created (with their workspace), by project and playbook. */
  private readonly creatingPipelines = new Map<string, Promise<Run>>();
  /** The plugin's own work (scripts, hand-offs, departures) runs one pass at a time; a call during a pass asks for another. */
  private ticking = false;
  private tickAgain = false;
  /** Sessions opened with this load of the plugin's tools, and the reload of older ones (stale-sessions.ts). */
  readonly sessions: StaleSessions;
  /** Role deciders reminded once to decide, by agent id. */
  private readonly remindedDeciders = new Set<string>();
  /** Role deciders of closed gates already stopped, by agent id. */
  private readonly stoppedDeciders = new Set<string>();

  private readonly usageLedger: UsageLedger;
  private readonly sidekickRegistry: SidekickRegistry;
  /** Sidekick agents that handed off and restart when their turn ends; those already asked to hand off; finish notices held for a busy Sidekick. */
  private readonly sidekickRolling = new Set<string>();
  private readonly sidekickAsked = new Set<string>();
  /** Gates (runId:gateId) already put to each Sidekick by an end-of-turn sweep, so a gate left for the human is not repeated every turn. */
  private readonly sidekickSwept = new Map<string, Set<string>>();
  private readonly sidekickHeld = new Map<string, string[]>();
  private readonly sidekickOpening = new Map<string, Promise<{ projectId: string; workspaceId: string; agentId: string; created: boolean }>>();

  /** The event bus (bus.ts) and its first producer, the runs (oversight-events.ts). */
  readonly bus: EventBus;
  private readonly producer: OversightProducer;
  private eventsScanning = false;
  private eventsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: RunStore,
    private readonly options: { dataDir?: string; debounceMs?: number; pollMs?: number; wakeGapMs?: number; admissionTimeoutMs?: number } = {},
  ) {
    const dir = options.dataDir ?? path.dirname(store.dir);
    this.worktreesDir = path.join(dir, "worktrees");
    this.sessions = new StaleSessions(path.join(dir, "sessions.json"));
    this.usageLedger = new UsageLedger(path.join(dir, "agent-usage.json"));
    this.sidekickRegistry = new SidekickRegistry(path.join(dir, "sidekick.json"));
    this.bus = new EventBus({ events: path.join(dir, "events.json"), subscriptions: path.join(dir, "subscriptions.json"), pending: path.join(dir, "pending-events.json") }, options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs });
    registerOversightTypes(this.bus);
    for (const def of JOB_TYPES) this.bus.register(def);
    // The jobs of a pipeline: committed mutations become the public job.* events (job-events.ts), in order.
    let jobEvents: Promise<unknown> = Promise.resolve();
    store.onEvents((run, events) => {
      for (const event of publicJobEvents(run, events)) {
        jobEvents = jobEvents.then(() => this.bus.emit(event.type, event.payload, { runId: run.id, source: "pipelines" })).catch((error: unknown) => console.error(`[playbooks] could not emit ${event.type}:`, errorText(error)));
      }
    });
    // Script steps with `wake_on` (script-wake.ts logic below): an internal listener, not an agent subscription.
    this.bus.onEmit((event) => {
      this.wakeScripts(event);
      this.wakeAdmissions(event);
    });
    this.bus.registerNotifier("agent", this.agentNotifier());
    this.producer = new OversightProducer(this.bus);
  }

  /**
   * Sends a subscription's events as a plain-text message to its agent; an archived or missing
   * agent is "gone". With `delivery: "idle"` (the default) a message waits ("held") while the agent
   * is in a turn, so it never lands in the middle of one (an interactive question, say), and goes
   * out as one message once the turn ends. The plugin's send is not an agent's, so on an idle agent
   * it starts a normal turn. Busy is `busyManagers` (turn hooks, sends the plugin made), and for an
   * agent we have not seen yet (after a restart) its status.
   */
  private agentNotifier(): Notifier {
    return {
      deliver: async (subscription: Subscription, _events: BusEvent[], text: string) => {
        const id = subscription.sink.target;
        const steer = subscription.delivery === "steer";
        if (!steer && this.busyManagers.has(id)) return "held";
        const agent = await this.api().agents.ref(id).refresh().catch(() => null);
        if (!agent || agent.agent.archivedAt) {
          console.warn(`[playbooks] dropping event subscriptions of ${id}: agent ${agent ? "is archived" : "no longer exists"}`);
          return "gone";
        }
        if (!steer && agent.agent.status === "running") {
          this.busyManagers.add(id);
          return "held";
        }
        if (!steer) this.busyManagers.add(id);
        try {
          await this.api().agents.ref(id).send(text, { activeTurnBehavior: "steer" });
        } catch (error) {
          if (!steer) this.busyManagers.delete(id);
          throw error;
        }
        return "delivered";
      },
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Every hook, tool and RPC context hands us the daemon API; the first one triggers reconcile. */
  attach(paseo: PaseoApi): Promise<void> {
    this.paseo ??= paseo;
    this.reconciled ??= this.reconcile()
      .catch((error) => console.error("[playbooks] reconcile failed:", error))
      .then(() => this.reloadStaleSessions())
      .catch((error) => console.error("[playbooks] stale session reload failed:", errorText(error)));
    if (!this.eventsTimer) {
      this.eventsTimer = setInterval(() => void this.watchEvents().catch((error) => console.error("[playbooks] event watch failed:", errorText(error))), this.options.pollMs ?? 2000);
      (this.eventsTimer as unknown as { unref?: () => void }).unref?.();
    }
    return this.reconciled;
  }

  /** Provider usage of the host (`providers.listUsage`): shared by every run, read at most once at a time and reused for a short while. */
  private readonly usage = new UsageCache(async () => (await this.api().providers.listUsage()) as unknown as UsageSnapshot);
  /** Usage skips already written to a run's log (`run|target|window|reset`), so a skip is logged once. */
  private readonly usageLogged = new Set<string>();

  /** The targets (`provider/model`) whose provider's usage is at the playbook's threshold now, with the window that blocks them. Empty when `providers.usage.check` is off or usage cannot be read. */
  private async usageBlocks(playbook: Pick<Playbook, "usageCheck" | "usageThreshold">, targets: Array<{ provider: string; model?: string | undefined }>): Promise<Map<string, UsageBlock>> {
    const blocks = new Map<string, UsageBlock>();
    if (!playbook.usageCheck || targets.length === 0) return blocks;
    const snapshot = await this.usage.read();
    for (const { provider, model } of targets) {
      const block = usageBlock(snapshot, provider, model, playbook.usageThreshold);
      if (block) blocks.set(`${provider}/${model}`, block);
    }
    return blocks;
  }

  /** Writes a `provider_usage_skip` line for a target skipped by usage (once per target and window reset) and returns the text for the manager. */
  private async noteUsageSkip(run: Run, stepId: string | null, target: string, block: UsageBlock): Promise<string> {
    const text = `${target} skipped: ${block.window} at ${Math.round(block.usedPct)}% of its limit${block.resetsAt ? `, resets ${new Date(block.resetsAt).toLocaleString()}` : ""}`;
    const key = `${run.id}|${target}|${block.window}|${block.resetsAt}`;
    if (!this.usageLogged.has(key)) {
      this.usageLogged.add(key);
      await this.store.mutate(run.id, (current) => engine.noteEvent(current, "provider_usage_skip", stepId, text, nowIso())).catch(() => undefined);
    }
    return text;
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
    return Promise.all([this.store.close(), this.bus.close(), this.sessions.flush()]).then(() => undefined);
  }

  /**
   * After a (re)start: re-arm timeouts, ask step agents whose turn the restart cut to carry on,
   * treat the ones that cannot as lost, wake idle managers of stalled runs, flush wake-ups.
   */
  private async reconcile(): Promise<void> {
    // Logged before anything ticks: a step found ready now was dropped by the previous plugin process.
    await this.logRecoveredSteps().catch((error) => console.error("[playbooks] recovery log failed:", errorText(error)));
    for (const run of this.store.list()) {
      try {
        await this.reconcileRun(run);
      } catch (error) {
        // One damaged run must not stop the others from being picked up again.
        console.error(`[playbooks] reconcile of ${run.id} failed:`, errorText(error));
      }
    }
    // Batch gates open before the restart were announced then: only their decisions are left to tell.
    for (const run of this.store.list()) {
      if (!run.batch || isTerminal(run.status)) continue;
      for (const gate of run.gates) if (gate.status === "pending") this.batchGates.add(`${run.id}/${gate.id}`);
    }
    await this.sweepWorktrees().catch((error) => console.error("[playbooks] worktree sweep failed:", errorText(error)));
    await this.admitQueued().catch((error) => console.error("[playbooks] admission after reconcile failed:", errorText(error)));
    await this.tick().catch((error) => console.error("[playbooks] tick after reconcile failed:", errorText(error)));
  }

  private async reconcileRun(run: Run): Promise<void> {
    {
      if (run.status === "boarding" || (isPipeline(run) && !isTerminal(run.status) && (run.playbook.singleton?.stages.length ?? 0) === 0)) {
        // Boarding runs and singleton runs of v0.30.0 were replaced by pipelines.
        await this.failRun(run.id, "singleton runs of v0.30.0 were replaced by pipelines; hand the job off again");
        return;
      }
      if (!isActive(run) || isPipeline(run)) return;
      // A run with no manager (manager.mode: none) cannot lose one: the plugin resumes it below and through its tick.
      if (!isManagerless(run)) {
        const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
        if (!manager || manager.agent.archivedAt) {
          await this.failManagerLost(run.id, "manager lost", `manager ${run.managerAgentId} ${manager ? "was archived" : "no longer exists"} before the daemon started: the plugin was not running to see who archived it`, null);
          return;
        }
        if (manager.agent.status === "running") this.busyManagers.add(run.managerAgentId);
      }
      for (const [stepId, state] of Object.entries(run.steps)) {
        if (state.status !== "running") continue;
        const attempt = state.attempts.at(-1)!;
        if (isScriptAttempt(attempt.agentId)) {
          // Checks are idempotent: the one cut by the restart runs again.
          this.armTimeout(run, stepId);
          this.runCheck(run.id, stepId, attempt.agentId, "first");
          continue;
        }
        if (isHandoffAttempt(attempt.agentId) || isFanoutAttempt(attempt.agentId)) {
          // Its job or its children wait in run state: only its timeout needs arming again (the scan follows the children).
          this.armTimeout(run, stepId);
          continue;
        }
        if (attempt.waiting) {
          this.armWait(run, stepId);
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
      // A report the restart cut between its recording and its application: applied now, or left reported for the manager.
      for (const [stepId, state] of Object.entries(this.store.get(run.id)!.steps)) {
        if (state.status === "reported") await this.autoCompleteReport(run.id, stepId);
      }
      await this.settleScripts(run.id);
      await this.reconcileDeciders(run.id);
      await this.wakeStalledManager(run.id);
      await this.deliver(run.id);
    }
  }

  /**
   * A step the plugin starts itself (fan-out, hand-off, script) found ready and not started at plugin start: its start was
   * dropped (a failure between the state change and the start). Logged as step_recovered; the tick that ends reconcile starts it, once (the start
   * re-checks the step is still ready inside the run's mutation, so it is never started twice).
   */
  private async logRecoveredSteps(): Promise<void> {
    for (const run of this.store.list()) {
      if (!isActive(run) || isPaused(run) || isPipeline(run)) continue;
      const stuck = [...engine.readyFanouts(run), ...engine.readyHandoffs(run), ...engine.readyScripts(run)];
      if (stuck.length === 0) continue;
      await this.store.mutate(run.id, (current) => {
        for (const stepId of stuck) if (current.steps[stepId]?.status === "ready") engine.noteEvent(current, "step_recovered", stepId, "ready and not started when the plugin started: starting it now", nowIso());
      }).catch((error) => console.error(`[playbooks] could not log the recovery of ${run.id}:`, errorText(error)));
    }
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
    if (!run || isManagerless(run) || !isActive(run) || isPaused(run) || run.inbox.length > 0 || this.busyManagers.has(run.managerAgentId)) return;
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

  async subscribeEvents(agentId: string, types: string[], filter: Record<string, string | number | boolean>, delivery: "idle" | "steer" = "idle"): Promise<Subscription> {
    try {
      if (typeof filter.runId === "string" && !this.store.get(filter.runId)) throw new UserError(`unknown run "${filter.runId}"`);
      return await this.bus.subscribe(agentId, { kind: "agent", target: agentId }, types, filter, delivery);
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
      // Fan-out children end in other runs: the scan is what notices them (no tokens, no agent).
      if (this.store.list().some((run) => isActive(run) && Object.values(run.steps).some((state) => state.fanout && state.status === "running"))) await this.tick();
    } finally {
      this.eventsScanning = false;
    }
  }

  /** A page of any agent's timeline, newest first when no cursor is given, else the entries before it. */
  async readTimeline(agentId: string, options: { limit: number; before?: { epoch: string; seq: number } }) {
    const handle = this.api().agents.ref(agentId);
    const page = await handle
      .timeline.refetch(options.before ? { direction: "before", cursor: options.before, limit: options.limit } : { direction: "tail", limit: options.limit })
      .catch((error: unknown) => {
        throw new UserError(`cannot read agent "${agentId}": ${error instanceof Error ? error.message : String(error)}`);
      });
    return { entries: page.entries, hasOlder: page.hasOlder, startCursor: page.startCursor };
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
    if (isManagerless(run)) throw new UserError(`run ${run.id} has no Playbook Manager (manager.mode: none): the plugin starts its steps, applies the reports, opens the gates and stops the run on a failure by itself. Nothing to start, complete, nudge or request; a human decides its gates in the panel`);
    if (run.managerAgentId !== managerId) throw new UserError(`run ${run.id} belongs to another manager`);
    return run;
  }

  // ---------------------------------------------------------------- manager wake-ups

  private async enqueue(runId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    // No manager (manager.mode: none): nobody reads an inbox; the plugin acts on the run's state itself.
    const target = this.store.get(runId);
    if (target && isManagerless(target)) return;
    await this.store.mutate(runId, (run) => {
      run.inbox.push(`[playbooks] ${run.id} · ${lines.join(" ")}`);
    });
  }

  /** Sends queued wake-ups to the manager when it is idle, merged into one prompt. A paused run keeps them until resume. */
  async deliver(runId: string): Promise<void> {
    const run = this.store.get(runId);
    // A pipeline has no manager: nothing to wake.
    if (!run || !run.managerAgentId || isManagerless(run) || run.inbox.length === 0 || isPaused(run) || this.busyManagers.has(run.managerAgentId)) return;
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
      this.wokenManagers.add(run.managerAgentId);
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
    // A manager that ends its turn with a hand-off pending (see chaseFollowUps) is woken again, or retired once none is.
    await this.chaseFollowUps();
    for (const run of this.runsOfManager(agentId)) await this.deliver(run.id);
    await this.compactManager(agentId);
    // Event notices held while this agent was in its turn (unless the above started a new one).
    if (!this.busyManagers.has(agentId)) await this.bus.flush();
  }

  /**
   * Sends `/compact` to a manager that is idle with nothing queued, after it handled a wake-up
   * or a gate decision, when the run's `manager.compact` asks for it. Sent like any message
   * (not as an agent), which is what makes Claude Code run it as a command. Never mid-turn, and
   * never while a wake-up waits: the next wake-up would find a manager compacting.
   */
  private async compactManager(agentId: string): Promise<void> {
    const woke = this.wokenManagers.has(agentId);
    const gate = this.gateManagers.has(agentId);
    if (!woke && !gate) return;
    if (this.busyManagers.has(agentId) || this.retiredManagers.has(agentId)) return;
    const runs = this.runsOfManager(agentId).filter((run) => isActive(run));
    if (runs.length === 0 || runs.some((run) => run.inbox.length > 0)) return;
    this.wokenManagers.delete(agentId);
    this.gateManagers.delete(agentId);
    const policy = runs[0]!.playbook.managerCompact;
    if (policy === "never" || (policy === "on_gate_decided" && !gate)) return;
    try {
      if (typeof policy === "object") {
        const current = await this.api().agents.ref(agentId).refresh();
        // A zero (or missing) reading is the one right after a compaction: not a size.
        const used = current?.agent.lastUsage?.contextWindowUsedTokens ?? 0;
        if (used <= policy.above_tokens) return;
      }
      this.busyManagers.add(agentId);
      await this.api().agents.ref(agentId).send("/compact");
    } catch (error) {
      this.busyManagers.delete(agentId);
      console.error(`[playbooks] could not compact manager ${agentId}:`, errorText(error));
    }
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
      if (isFanoutAttempt(agentId)) {
        await this.cancelFanoutChildren(runId, agentId, "its fan-out step was canceled or reset, or its run ended");
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
        config: { ...config, systemPrompt: gateDeciderSystemPrompt(run.playbook, gate, role, choices, run) },
        ...(run.managerAgentId ? { parent: run.managerAgentId } : {}),
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
    // A batch's gate is now announced to the runs whose jobs it carries.
    if (run.batch) await this.tick();
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
    const workspaceDir = workspace.workspaceDirectory ?? manager.cwd;
    const reservation = this.reservationFor(workspace.id, playbookId, inputs);
    let playbook: Playbook | null = options.playbook ?? (reservation && reservation.playbook.id === playbookId ? reservation.playbook : null);
    if (!playbook) {
      const loaded = await loadPlaybooks(workspaceDir, { projectId: workspace.projectId });
      const found = findEntry(loaded.entries, playbookId);
      if ("error" in found) throw new UserError(found.error);
      const entry = found.entry;
      if (!entry) throw new UserError(`no playbook "${playbookId}" in this workspace (have: ${loaded.entries.map((e) => e.id).join(", ") || "none"})`);
      if (!entry.playbook) throw new UserError(`playbook "${playbookId}" is invalid:\n${entry.errors.join("\n")}`);
      playbook = entry.playbook;
    }
    this.checkWorkspaceFree(workspace.id, playbook.isolation.mode === "worktree");
    if (playbook.singleton) return this.startPipeline(workspaceDir, workspace.projectId, playbook);
    this.checkConcurrency(playbook, workspace.projectId);
    const runId = reservation?.runId ?? `run_${shortId()}`;
    const created = playbook.isolation.mode === "worktree" ? await this.createRunWorktree(runId, playbook, workspaceDir, reservation?.branch ?? null) : undefined;
    const worktree = created?.worktree;
    // The run's rules are the base branch's as of now, read from its own worktree: no need to fast-forward the workspace.
    const chosen = created ? await chooseDefinition({ projectId: workspace.projectId, playbook, worktreeDir: created.worktree.path, baseRef: created.worktree.base, baseSha: created.worktree.baseSha, fetchError: created.fetchError }) : undefined;
    if (chosen) playbook = chosen.playbook;
    let run: Run;
    try {
      run = engine.newRun({
        id: runId,
        playbook,
        workspaceId: workspace.id,
        workspaceDir,
        projectId: workspace.projectId,
        branch: worktree?.branch ?? reservation?.branch ?? (await currentRef(workspaceDir)),
        // manager.mode: none: the run has no manager agent (the plugin drives it); `manager` here is only the caller.
        managerAgentId: playbook.managerMode === "none" ? "" : manager.id,
        workspaceCreated: reservation?.created === true,
        ...(worktree ? { worktree } : {}),
        ...(chosen ? { definition: chosen.definition } : {}),
        name: runName(options.name),
        ...(reservation?.parent ? { parent: reservation.parent } : {}),
        inputs,
        now: nowIso(),
      });
      await this.store.create(run);
    } catch (error) {
      if (worktree) await this.dropWorktree(runId, worktree, workspaceDir, true).catch(() => undefined);
      throw error;
    } finally {
      this.creatingWorktrees.delete(runId);
    }
    if (reservation) this.dropReservation(workspace.id, reservation);
    await this.admitQueued(run.id);
    return this.store.get(run.id)!;
  }

  // ---------------------------------------------------------------- isolated runs (isolation: worktree)

  /**
   * One non-isolated run may own a workspace; any number of isolated runs may share it, because
   * they work in worktrees. The two do not mix: a non-isolated run edits the checkout that the
   * isolated runs' guard watches.
   */
  private workspaceConflict(workspaceId: string, isolated: boolean, exceptRunId?: string): Run | undefined {
    return this.store.list().find((run) => run.id !== exceptRunId && run.workspaceId === workspaceId && isActive(run) && (!isolated ? true : run.playbook.isolation.mode !== "worktree"));
  }

  private checkWorkspaceFree(workspaceId: string, isolated: boolean, exceptRunId?: string): void {
    const other = this.workspaceConflict(workspaceId, isolated, exceptRunId);
    if (!other) return;
    const otherIsolated = other.playbook.isolation.mode === "worktree";
    throw new UserError(
      isolated
        ? `this workspace has an active run without isolation (${other.id}), which works in the workspace checkout: wait for it to end`
        : otherIsolated
          ? `this workspace has an active isolated run (${other.id}); a run without isolation edits the checkout those runs guard: wait for it to end, or set \`isolation: worktree\` on this playbook`
          : `this workspace already has an active run (${other.id}); one active run per workspace (several runs may share a workspace only with \`isolation: worktree\`)`,
    );
  }

  /** `git worktree add` for the run, under the plugin's data directory; the guard's baseline is taken here. */
  private async createRunWorktree(runId: string, playbook: Playbook, workspaceDir: string, takenBranch: string | null): Promise<{ worktree: RunWorktree; fetchError: string | null }> {
    const id = runId.replace(/^run_/, "");
    let branch = worktreeBranch(playbook.id, id);
    if (branch === takenBranch) branch = `${branch}-wt`;
    this.creatingWorktrees.add(runId);
    try {
      const created = await createWorktree({ workspaceDir, worktreesDir: this.worktreesDir, runId, branch, isolation: playbook.isolation });
      const { fetchError, ...worktree } = created;
      return { worktree: { ...worktree, state: "active" }, fetchError };
    } catch (error) {
      this.creatingWorktrees.delete(runId);
      throw new UserError(`could not create the run's worktree (isolation: worktree): ${errorText(error)}`);
    }
  }

  /**
   * The run's worktree, ready for work: the one that exists, or (an ended run's was deleted) a new one
   * on the run's branch (kept locally or pushed) or fresh off the base. The guard's baseline is retaken.
   * Null for a run that is not isolated.
   */
  private async ensureWorktree(run: Run, workspaceDir: string): Promise<RunWorktree | null> {
    const wt = run.worktree;
    if (!wt) return null;
    const workspaceSnapshot = await checkoutSnapshot(workspaceDir);
    if (wt.state !== "removed" && existsSync(wt.path)) return { ...wt, state: "active", workspaceSnapshot };
    this.creatingWorktrees.add(run.id);
    try {
      const created = await createWorktree({ workspaceDir, worktreesDir: this.worktreesDir, runId: run.id, branch: wt.branch, isolation: run.playbook.isolation, reuseBranch: true });
      const { fetchError: _fetchError, ...recreated } = created;
      return { ...recreated, base: wt.base, baseSha: wt.baseSha, state: "active" };
    } catch (error) {
      throw new UserError(`could not recreate the run's worktree: ${errorText(error)}`);
    } finally {
      this.creatingWorktrees.delete(run.id);
    }
  }

  /** The repository a run's worktree belongs to: read from the worktree itself, else the workspace. */
  private async repoOf(run: Run, worktree: RunWorktree): Promise<string> {
    return (await repoOfWorktree(worktree.path))?.repo ?? run.workspaceDir;
  }

  /**
   * Isolated run ended: deletes its worktree (and its branch, unless that holds unpushed commits).
   * Kept, with the reason in the history, when the run failed and `workspace.keep_failed` is true,
   * when the worktree has uncommitted changes, or when the original checkout changed during the run.
   */
  private async cleanupEndedWorktrees(): Promise<void> {
    for (const candidate of this.store.list()) {
      const wt = candidate.worktree;
      if (!wt || wt.state !== "active" || !isTerminal(candidate.status) || isActive(candidate)) continue;
      try {
        if (await this.runAgentsBusy(candidate)) continue;
        const keep = await this.worktreeKeepReason(candidate, wt);
        if (keep) {
          await this.store.mutate(candidate.id, (run) => {
            run.worktree = { ...wt, state: "kept" };
            engine.noteEvent(run, "worktree_kept", null, `worktree ${wt.path} kept: ${keep.reason}`, nowIso());
            if (keep.violation) engine.noteEvent(run, "isolation_violation", null, keep.violation, nowIso());
          });
          if (keep.violation && isManagerless(candidate)) {
            // Nobody to tell (manager.mode: none): the ended run is marked failed, so the panel and the Sidekick's run.failed event show it.
            await this.store.mutate(candidate.id, (run) => engine.failCompletedRun(run, `Isolation violated: the original workspace checkout changed (${keep.violation}) although the run works in its worktree; the worktree ${wt.path} is kept`, nowIso()));
            continue;
          }
          if (keep.violation) {
            await this.enqueue(candidate.id, [`Isolation guard: the run ended but the original workspace checkout changed (${keep.violation}) although the run works in its worktree. Tell the human; the worktree ${wt.path} is kept.`]);
            await this.deliver(candidate.id);
          }
          continue;
        }
        const removed = await this.dropWorktree(candidate.id, wt, await this.repoOf(candidate, wt), false);
        await this.store.mutate(candidate.id, (run) => {
          run.worktree = { ...wt, state: "removed" };
          engine.noteEvent(run, "worktree_removed", null, `worktree ${wt.path} removed${removed.keptBranch ? `; branch ${removed.keptBranch} kept: it has commits that are not pushed` : `; branch ${wt.branch} deleted`}`, nowIso());
        });
      } catch (error) {
        console.error(`[playbooks] could not clean up the worktree of ${candidate.id}:`, errorText(error));
      }
    }
  }

  private async worktreeKeepReason(run: Run, wt: RunWorktree): Promise<{ reason: string; violation?: string } | null> {
    if (run.status === "failed" && run.playbook.workspace.keepFailed) return { reason: "the run failed and workspace.keep_failed is true" };
    if (wt.workspaceSnapshot) {
      const violation = snapshotDiff(wt.workspaceSnapshot, await checkoutSnapshot(run.workspaceDir));
      if (violation) return { reason: "the original workspace checkout changed during the run", violation };
    }
    if (existsSync(wt.path)) {
      const dirty = await dirtyPaths(wt.path, wt.linked);
      if (dirty.length > 0) return { reason: `it has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}); remove it by hand once they are saved` };
    }
    return null;
  }

  /** Whether an agent of the run still runs (a canceled run's agents stop shortly after). */
  private async runAgentsBusy(run: Run): Promise<boolean> {
    const listed = await this.api().agents.list({ filter: { projectKeys: [run.projectId] } });
    return listed.entries.some(({ agent }) => agent.labels?.[RUN_LABEL] === run.id && !agent.archivedAt && (agent.status === "running" || agent.status === "initializing"));
  }

  /**
   * Orphans: a directory of the worktrees folder whose run is gone (or says it was removed) is deleted
   * with its git metadata, so a crash, a deleted run or a daemon restart cannot leave one behind.
   * Uncommitted changes of an orphan are dropped (nobody can claim it) and logged; its branch goes
   * unless it holds unpushed commits. Returns the directories removed.
   */
  async sweepWorktrees(): Promise<string[]> {
    const removed: string[] = [];
    const runs = new Map(this.store.list().map((run) => [run.id, run]));
    for (const name of await listWorktreeDirs(this.worktreesDir)) {
      if (this.creatingWorktrees.has(name)) continue;
      const record = runs.get(name);
      if (record?.worktree && record.worktree.state !== "removed") continue;
      const dir = path.join(this.worktreesDir, name);
      try {
        const origin = await repoOfWorktree(dir);
        const linked = origin ? await linkedSubmodules(dir) : [];
        await this.teardownWorktree(dir, origin?.repo ?? this.worktreesDir);
        const result = await removeWorktree({ repo: origin?.repo ?? this.worktreesDir, dir, worktreesDir: this.worktreesDir, branch: origin?.branch ?? null, linked, force: true, ...(record?.worktree ? { baseSha: record.worktree.baseSha } : {}) });
        removed.push(dir);
        console.log(`[playbooks] removed orphan worktree ${dir}${result.dropped.length ? ` (dropped uncommitted: ${result.dropped.slice(0, 10).join(", ")})` : ""}${result.keptBranch ? `; kept branch ${result.keptBranch}` : ""}`);
      } catch (error) {
        console.error(`[playbooks] could not remove orphan worktree ${dir}:`, errorText(error));
      }
    }
    for (const repo of new Set(this.store.list().map((run) => run.workspaceDir))) {
      await pruneWorktrees(repo);
    }
    return removed;
  }

  /** Removes a run's worktree and records nothing; callers write the history. */
  private async dropWorktree(runId: string, worktree: RunWorktree, repo: string, force: boolean): Promise<{ keptBranch: string | null; dropped: string[] }> {
    const dir = worktree.path || worktreePath(this.worktreesDir, runId);
    await this.teardownWorktree(dir, repo);
    return removeWorktree({ repo, dir, worktreesDir: this.worktreesDir, branch: worktree.branch, linked: worktree.linked, baseSha: worktree.baseSha, force });
  }

  /** Runs the repository's `worktree.teardown` (its `paseo.json`) in a worktree about to be removed; failures are logged and never block the removal. */
  private async teardownWorktree(dir: string, repo: string): Promise<void> {
    const result = await runWorktreeTeardown({ dir, repo });
    for (const failure of result.failed) console.error(`[playbooks] worktree teardown failed in ${dir} (${failure.command}): ${failure.reason}`);
  }

  private reservationFor(workspaceId: string, playbookId: string, inputs: Record<string, unknown>): Reservation | undefined {
    const list = this.reservations.get(workspaceId) ?? [];
    const same = (r: Reservation) => r.playbook.id === playbookId;
    return list.find((r) => same(r) && JSON.stringify(r.inputs) === JSON.stringify(inputs)) ?? list.find(same) ?? list[0];
  }

  private addReservation(workspaceId: string, reservation: Reservation): void {
    this.reservations.set(workspaceId, [...(this.reservations.get(workspaceId) ?? []), reservation]);
  }

  private dropReservation(workspaceId: string, reservation: Reservation): void {
    const rest = (this.reservations.get(workspaceId) ?? []).filter((r) => r !== reservation);
    if (rest.length > 0) this.reservations.set(workspaceId, rest);
    else this.reservations.delete(workspaceId);
  }

  /** Slots are shared: active runs of the playbook, and blocks of it that other runs hold. */
  private checkConcurrency(playbook: Playbook, projectId: string): void {
    if (playbook.concurrency === undefined) return;
    const holders = slotHolders(this.store.list(), projectId, playbook.id);
    if (holders.length >= playbook.concurrency) {
      throw new ConcurrencyError(
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

  /** Starts ready script and hand-off steps, ends the jobs of ended singleton runs, and starts boarding runs. */
  private async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.tickPhase("driveManagerless", () => this.driveManagerless());
        await this.tickPhase("settleGateChats", () => this.settleGateChats());
        await this.tickPhase("askGatesInChat", () => this.askGatesInChat());
        await this.tickPhase("startScripts", () => this.startScripts());
        await this.tickPhase("driveAdmissions", () => this.driveAdmissions());
        await this.tickPhase("startHandoffs", () => this.startHandoffs());
        await this.tickPhase("driveFanouts", () => this.driveFanouts());
        await this.tickPhase("runDeciders", () => this.runDeciders());
        await this.tickPhase("noticeBatchGates", () => this.noticeBatchGates());
        await this.tickPhase("endBatches", () => this.endBatches());
        await this.tickPhase("chaseFollowUps", () => this.chaseFollowUps());
        await this.tickPhase("startBatches", () => this.startBatches());
        await this.tickPhase("cleanupEndedWorktrees", () => this.cleanupEndedWorktrees());
        await this.tickPhase("archiveEndedWorkspaces", () => this.archiveEndedWorkspaces());
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
  }

  /** One step of the tick: a failure is reported and the next phases still run (one damaged run must not stop every run's ready steps). */
  private async tickPhase(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(`[playbooks] tick phase ${name} failed:`, errorText(error));
    }
  }

  // ---------------------------------------------------------------- runs with no manager (manager.mode: none)

  /**
   * The plugin does what a Playbook Manager does, for every active, unpaused run with `manager.mode: none`: normalizes its
   * gates (a manager-decided gate goes to a human), applies the reported steps, opens the gates of ready gate steps and
   * starts the ready agent steps. One pass per tick; each outcome of a pass makes ready steps, so the tick runs again.
   */
  private async driveManagerless(): Promise<void> {
    for (const candidate of this.store.list()) {
      if (!isManagerless(candidate) || !isActive(candidate) || isPaused(candidate)) continue;
      const runId = candidate.id;
      // No manager decides a gate: one that named the manager is a human's.
      await this.store.mutate(runId, (run) => {
        for (const gate of run.gates) if (gate.status === "pending" && gate.decider.by === "manager") gate.decider = { by: "human" };
      });
      for (const step of candidate.playbook.steps) {
        const run = this.store.get(runId)!;
        if (!isActive(run) || isPaused(run)) break;
        if (step.kind === "agent" && run.steps[step.id]!.status === "reported" && isStepLive(run, step.id)) await this.applyReportedByPlugin(runId, step.id);
      }
      for (const stepId of engine.readySteps(this.store.get(runId)!)) {
        const run = this.store.get(runId)!;
        if (!isActive(run) || isPaused(run)) break;
        const step = engine.stepDef(run, stepId);
        if (run.steps[stepId]!.status !== "ready") continue;
        if (step.kind === "gate") {
          await this.store.mutate(runId, (current) => {
            if (current.steps[stepId]!.status !== "ready") return;
            const gate = engine.requestGate(current, stepId, step.title || step.id, nowIso());
            if (gate.decider.by === "manager") gate.decider = { by: "human" };
          });
        } else if (step.kind === "agent") {
          try {
            await this.startStep("", runId, stepId, "");
          } catch (error) {
            await this.stopRunByPlugin(runId, `step "${stepId}" could not start: ${errorText(error)}`);
          }
        }
      }
      // A gate opened above starts its role decider in the same tick (runDeciders follows).
    }
  }

  /**
   * A reported agent step of a run with no manager: every reported outcome is applied as the manager's complete_step would
   * (same checks, same events). A step that ended with no report, or whose agent was lost or stopped, counts as a failure
   * (the YAML's `retries` / `on` decide what follows; a lost or stopped agent stops the run). A failure that ends the run
   * leaves it failed, with the step's text in `failure`.
   */
  private async applyReportedByPlugin(runId: string, stepId: string): Promise<void> {
    const run = this.store.get(runId)!;
    const step = engine.stepDef(run, stepId);
    const attempt = run.steps[stepId]!.attempts.at(-1)!;
    const head = `step "${stepId}" attempt ${attempt.n}`;
    let report = attempt.report;
    if (!report) {
      const why = `${head} ended (${attempt.turnEnd ?? "?"}) without reporting${attempt.lastMessage ? `: ${attempt.lastMessage.slice(0, 500)}` : ""}`;
      if (attempt.turnEnd === "lost" || attempt.turnEnd === "canceled" || !step.outcomes.includes("failure")) return this.stopRunByPlugin(runId, why);
      report = { outcome: "failure", summary: why, outputs: {} };
    }
    if (!step.outcomes.includes(report.outcome)) return this.stopRunByPlugin(runId, `${head} reported "${report.outcome}", which the step does not declare (${step.outcomes.join(", ")}): ${report.summary}`);
    const input = { outcome: report.outcome, summary: report.summary, outputs: report.outputs, now: nowIso() };
    let effects: engine.Effects | null;
    try {
      effects = await this.store.mutate(runId, (current) => {
        const live = current.steps[stepId];
        if (live?.status !== "reported" || live.attempts.at(-1)?.n !== attempt.n || isPaused(current)) return null;
        const done = engine.completeStep(current, stepId, input);
        // A run that ends on this report says why: the step's own text, not only that it ended.
        if (current.status === "failed" && current.failure && report.summary && !current.failure.includes(report.summary)) current.failure = `${current.failure}: ${report.summary.slice(0, 500)}`;
        return done;
      });
    } catch (error) {
      return this.stopRunByPlugin(runId, `${head} reported ${report.outcome} but it could not be applied: ${errorText(error)}`);
    }
    if (!effects) return;
    await this.applyEffects(runId, effects);
    await this.admitQueued(runId);
  }

  /** Whether a run (by id) has no manager: for the step agents' tool list. */
  isManagerlessRun(runId: string | undefined): boolean {
    const run = runId ? this.store.get(runId) : undefined;
    return run !== undefined && isManagerless(run);
  }

  /** In-memory: gates with no live agent to ask, so they are not looked at every tick (the panel decides them). */
  private readonly chatSkipped = new Set<string>();

  /**
   * A run with no manager: a human gate is shown in the panel and, when the step agent that precedes it is still alive
   * (not archived, idle), also put to the human in that agent's conversation: the plugin asks it to use AskUserQuestion and
   * then answer_gate. Either surface closes the gate (settleGateChats tidies the other).
   */
  private async askGatesInChat(): Promise<void> {
    for (const run of this.store.list()) {
      if (!isManagerless(run) || !isActive(run) || isPaused(run)) continue;
      for (const gate of run.gates) {
        const key = `${run.id}:${gate.id}`;
        if (!waitsForHuman(gate) || gate.chatAgentId || this.chatSkipped.has(key)) continue;
        const step = engine.stepDef(run, gate.stepId);
        const owners = gate.kind === "ask" ? [gate.stepId] : step.needs;
        const candidates = owners
          .map((id) => ({ id, attempt: run.steps[id]?.attempts.at(-1) }))
          .filter((entry): entry is { id: string; attempt: NonNullable<typeof entry.attempt> } => entry.attempt !== undefined && !isAgentlessAttempt(entry.attempt.agentId))
          .sort((a, b) => Date.parse(b.attempt.endedAt ?? b.attempt.startedAt) - Date.parse(a.attempt.endedAt ?? a.attempt.startedAt));
        let target: string | null = null;
        let busy = false;
        for (const { attempt } of candidates) {
          const agent = await this.api().agents.ref(attempt.agentId).refresh().catch(() => null);
          if (!agent || agent.agent.archivedAt) continue;
          if (agent.agent.status !== "idle") busy = true;
          else {
            target = attempt.agentId;
            break;
          }
        }
        if (!target) {
          // A busy agent is asked when its turn ends; none alive: the panel only.
          if (!busy) this.chatSkipped.add(key);
          continue;
        }
        const claimed = await this.store.mutate(run.id, (current) => {
          const live = current.gates.find((candidate) => candidate.id === gate.id);
          if (!live || live.status !== "pending" || live.chatAgentId) return false;
          live.chatAgentId = target;
          return true;
        });
        if (!claimed) continue;
        try {
          await this.api().agents.ref(target).send(gateChatPrompt(run.id, gate, choicesOfGate(gate, step)));
        } catch (error) {
          console.error(`[playbooks] could not put gate ${gate.id} of ${run.id} to agent ${target}:`, errorText(error));
          await this.store.mutate(run.id, (current) => {
            const live = current.gates.find((candidate) => candidate.id === gate.id);
            if (live) live.chatAgentId = null;
          });
          this.chatSkipped.add(key);
        }
      }
    }
  }

  /** A gate that was put to an agent and is now closed: if the panel (or a cancel) closed it, the agent's open question is dismissed. */
  private async settleGateChats(): Promise<void> {
    for (const run of this.store.list()) {
      for (const gate of run.gates) {
        if (!gate.chatAgentId || gate.chatClosed || gate.status === "pending") continue;
        await this.store.mutate(run.id, (current) => {
          const live = current.gates.find((candidate) => candidate.id === gate.id);
          if (live) live.chatClosed = true;
        });
        if (gate.decidedVia === "chat") continue;
        const how = gate.decidedVia ? `in the Playbooks panel: ${gate.status}` : `because the run ${run.status}`;
        await this.dismissQuestions(gate.chatAgentId, `Gate ${gate.id} was closed ${how}. Do not call answer_gate. End your turn.`);
      }
    }
  }

  /** answer_gate: the human answered the gate's question in this step agent's conversation. */
  async answerGateFromChat(agentId: string, input: { gateId: string; decision: string; comment: string | null }): Promise<string> {
    let found: { run: Run; gate: Gate } | null = null;
    for (const run of this.store.list()) {
      const gate = run.gates.find((candidate) => candidate.chatAgentId === agentId && (candidate.id === input.gateId || candidate.stepId === input.gateId));
      if (gate) found = { run, gate };
    }
    if (!found) throw new UserError(`no gate "${input.gateId}" was put to you: nothing to answer`);
    if (found.gate.status !== "pending") return `Gate ${found.gate.id} is already decided (${found.gate.status}${found.gate.decidedVia ? ` via ${found.gate.decidedVia}` : ""}). Do not answer it again: end your turn.`;
    const result = await this.decideGate(found.run.id, found.gate.id, { decision: input.decision, comment: input.comment, by: "a human, in the conversation", via: "chat", now: nowIso() });
    if (result.alreadyDecided) return `Gate ${result.gate.id} was just decided (${result.gate.status} via ${result.gate.decidedVia ?? "?"}). End your turn.`;
    return `Recorded "${input.decision}" for gate ${result.gate.id}. End your turn: the plugin carries on.`;
  }

  /** A run with no manager stops in its failed state: visible in the panel, `run.failed` is emitted, restart_run works. */
  private async stopRunByPlugin(runId: string, reason: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run || isTerminal(run.status)) return;
    await this.failRun(runId, reason);
  }

  // ---------------------------------------------------------------- workspace archiving

  /**
   * `workspace: { archive: on_end }`: archives the workspace the plugin created for a run once the
   * run has ended and nothing else lives there. Every check is programmatic; a refusal is
   * written in the run's history and never fails the run.
   */
  private async archiveEndedWorkspaces(): Promise<void> {
    for (const candidate of this.store.list()) {
      if (candidate.workspaceArchive !== null || !candidate.workspaceCreated || !isTerminal(candidate.status) || candidate.batch || isPipeline(candidate)) continue;
      if (candidate.playbook.workspace.archive !== "on_end") continue;
      const verdict = await this.workspaceArchiveVerdict(candidate.id).catch((error: unknown) => ({ skip: `could not check: ${errorText(error)}` }));
      if (verdict === "wait") continue;
      if (verdict === "ok") {
        const archived = await this.api().workspaces.ref(candidate.workspaceId).archive().then(() => null, (error: unknown) => errorText(error));
        if (archived === null) {
          await this.store.mutate(candidate.id, (run) => {
            run.workspaceArchive = "done";
            engine.noteEvent(run, "workspace_archived", null, `workspace ${run.workspaceId} archived (workspace.archive: on_end)`, nowIso());
          });
          continue;
        }
        await this.skipWorkspaceArchive(candidate.id, `archive_workspace failed: ${archived}`);
        continue;
      }
      await this.skipWorkspaceArchive(candidate.id, verdict.skip);
    }
  }

  private async skipWorkspaceArchive(runId: string, reason: string): Promise<void> {
    await this.store.mutate(runId, (run) => {
      run.workspaceArchive = "skipped";
      engine.noteEvent(run, "workspace_kept", null, `workspace ${run.workspaceId} not archived: ${reason}`, nowIso());
    });
  }

  /** "ok": archive it; "wait": ask again later (something is still running); otherwise why it is kept. */
  private async workspaceArchiveVerdict(runId: string): Promise<"ok" | "wait" | { skip: string }> {
    const run = this.store.get(runId)!;
    if (run.status === "failed" && run.playbook.workspace.keepFailed) return { skip: "the run failed and keep_failed is true" };
    const others = this.store.list().filter((other) => other.id !== run.id && other.workspaceId === run.workspaceId);
    if (others.some((other) => isActive(other))) return "wait";
    const open = others.concat(run).find((other) => other.gates.some((gate) => gate.status === "pending"));
    if (open) return { skip: `run ${open.id} has an open gate` };
    const workspace = await this.api().workspaces.ref(run.workspaceId).refresh();
    if (!workspace) return { skip: "the workspace no longer exists" };
    const listed = await this.api().agents.list({ filter: { projectKeys: [run.projectId] } });
    const agents = listed.entries.map((entry) => entry.agent).filter((agent) => agent.workspaceId === run.workspaceId && !agent.archivedAt && !agent.internal);
    const runIds = new Set(this.store.list().filter((other) => other.workspaceId === run.workspaceId).map((other) => other.id));
    const foreign = agents.filter((agent) => !(agent.labels?.[MANAGER_LABEL] === "true" || (agent.labels?.[RUN_LABEL] && runIds.has(agent.labels[RUN_LABEL]))));
    if (foreign.length > 0) return { skip: `it holds agents the plugin did not create: ${foreign.map((agent) => agent.id).join(", ")}` };
    if (agents.some((agent) => agent.status === "running" || agent.status === "initializing")) return "wait";
    return "ok";
  }

  // ---------------------------------------------------------------- fan-out steps

  /** Starts the ready fan-out steps and moves every running one forward: notices ended child runs, starts pending ones under `max_active`, joins. */
  private async driveFanouts(): Promise<void> {
    for (const listed of this.store.list()) {
      if (!isActive(listed) || isPaused(listed) || isPipeline(listed)) continue;
      await this.driveFanoutsOf(listed).catch((error: unknown) => console.error(`[playbooks] fan-outs of ${listed.id} failed:`, errorText(error)));
    }
  }

  private async driveFanoutsOf(listed: Run): Promise<void> {
    {
      for (const stepId of engine.readyFanouts(listed)) {
        const begun = await this.store.mutate(listed.id, (current) => {
          if (current.steps[stepId]!.status !== "ready" || isPaused(current)) return null;
          const id = fanoutAttemptId(current.id, stepId, current.steps[stepId]!.attempts.length + 1);
          return { id, ...engine.startFanout(current, stepId, { agentId: id, now: nowIso() }) };
        });
        if (!begun) continue;
        this.armTimeout(this.store.get(listed.id)!, stepId);
        if (begun.error) await this.finishFanout(listed.id, stepId, begun.id, { outcome: "failure", summary: begun.error, outputs: {} });
      }
      for (const step of listed.playbook.steps) {
        if (!step.fanout) continue;
        const attempt = this.store.get(listed.id)?.steps[step.id]?.attempts.at(-1);
        if (attempt && isFanoutAttempt(attempt.agentId) && this.store.get(listed.id)!.steps[step.id]!.status === "running") {
          await this.advanceFanout(listed.id, step.id, attempt.agentId).catch((error: unknown) => console.error(`[playbooks] fan-out "${step.id}" of ${listed.id} failed to advance:`, errorText(error)));
        }
      }
    }
  }

  private isReservedRun(runId: string): boolean {
    return [...this.reservations.values()].some((list) => list.some((reservation) => reservation.runId === runId));
  }

  private async advanceFanout(runId: string, stepId: string, attemptId: string): Promise<void> {
    const live = (run: Run | undefined) => run?.steps[stepId]?.attempts.at(-1)?.agentId === attemptId && run.steps[stepId]!.status === "running";
    await this.store.mutate(runId, (current) => {
      if (!live(current)) return;
      engine.syncFanout(current, stepId, { now: nowIso(), nowMs: Date.now(), runOf: (id) => this.store.get(id), reserved: (id) => this.isReservedRun(id), startTimeoutMs: FANOUT_START_TIMEOUT_MS });
    });
    const run = this.store.get(runId);
    if (!live(run)) return;
    const step = engine.stepDef(run!, stepId);
    const state = run!.steps[stepId]!.fanout!;
    for (const child of engine.childrenToStart(state, step.fanout!.maxActive)) {
      // Marked starting before anything is created: a second pass, or a restart, never starts it again.
      const marked = await this.store.mutate(runId, (current) => {
        const target = live(current) ? current.steps[stepId]!.fanout!.children.find((candidate) => candidate.key === child.key) : undefined;
        if (!target || target.status !== "pending") return null;
        target.status = "starting";
        target.runId = `run_${shortId()}`;
        target.startedAt = nowIso();
        engine.noteEvent(current, "fanout_child_starting", stepId, `${target.key}: ${target.runId}`, nowIso());
        return target.runId;
      });
      if (!marked) continue;
      const settle = (change: (target: FanoutChildState) => void) =>
        this.store.mutate(runId, (current) => {
          const target = current.steps[stepId]?.fanout?.children.find((candidate) => candidate.key === child.key);
          if (target) change(target);
        });
      try {
        const started = await this.startFromPanel({
          workspaceId: run!.workspaceId,
          playbook: step.fanout!.playbook,
          inputs: child.inputs,
          force: false,
          workspaceName: child.workspaceName,
          child: { runId: marked, parent: { runId, stepId, key: child.key } },
        });
        if (started.status === "duplicate") {
          await settle((target) => Object.assign(target, { status: "not_started", runId: null, error: `${started.message} Not started again.`, endedAt: nowIso() }));
        } else {
          await settle((target) => {
            target.workspaceId = started.workspaceId;
          });
        }
      } catch (error) {
        if (error instanceof ConcurrencyError) {
          // Waits for a free slot of the child playbook's `concurrency`.
          await settle((target) => Object.assign(target, { status: "pending", runId: null, startedAt: null }));
          break;
        }
        await settle((target) => Object.assign(target, { status: "not_started", runId: null, error: errorText(error), endedAt: nowIso() }));
      }
    }
    const after = this.store.get(runId)!;
    if (live(after) && engine.fanoutJoined(after.steps[stepId]!.fanout!)) {
      await this.finishFanout(runId, stepId, attemptId, engine.fanoutResult(after.steps[stepId]!.fanout!));
    }
  }

  /** Records the join's result as the attempt's report and ends it; the step completes now, or on resume if the run is paused. */
  private async finishFanout(runId: string, stepId: string, attemptId: string, result: { outcome: string; summary: string; outputs: Record<string, unknown> }): Promise<void> {
    this.clearTimeout(attemptId);
    await this.store.mutate(runId, (run) => {
      const attempt = run.steps[stepId]?.attempts.at(-1);
      if (attempt?.agentId !== attemptId || run.steps[stepId]!.status !== "running") return;
      engine.recordAutomaticReport(run, attemptId, result, nowIso());
      engine.endTurn(run, attemptId, { turnEnd: "completed", lastMessage: result.summary, now: nowIso() });
    });
    await this.settleScripts(runId);
  }

  /**
   * Stops the children of a fan-out attempt that ended without joining (the run was canceled or failed, the step was reset or
   * timed out): waiting ones are marked not started, active runs are canceled, and a run still being created is never created.
   * Does nothing with `cancel_children: false`; the children then keep running unobserved.
   */
  private async cancelFanoutChildren(runId: string, attemptId: string, reason: string): Promise<void> {
    const run = this.store.get(runId);
    const step = run?.playbook.steps.find((candidate) => candidate.fanout && run.steps[candidate.id]?.attempts.at(-1)?.agentId === attemptId);
    if (!run || !step?.fanout?.cancelChildren) return;
    const children = run.steps[step.id]!.fanout?.children.filter((child) => !engine.isChildDone(child)) ?? [];
    const outcomes = new Map<string, "canceled" | "not_started">();
    for (const child of children) {
      if (child.status === "pending" || !child.runId) {
        outcomes.set(child.key, "not_started");
        continue;
      }
      for (const [workspaceId, list] of this.reservations) {
        const rest = list.filter((reservation) => reservation.runId !== child.runId);
        if (rest.length !== list.length) rest.length > 0 ? this.reservations.set(workspaceId, rest) : this.reservations.delete(workspaceId);
      }
      const childRun = this.store.get(child.runId);
      if (childRun && !isTerminal(childRun.status)) await this.cancelRun(child.runId, `its parent run's fan-out step "${step.id}" stopped: ${reason}`, "because its parent run's fan-out stopped").catch((error: unknown) => console.error(`[playbooks] could not cancel child run ${child.runId}:`, errorText(error)));
      outcomes.set(child.key, childRun || child.status === "running" ? "canceled" : "not_started");
    }
    await this.store.mutate(runId, (current) => {
      for (const target of current.steps[step.id]!.fanout?.children ?? []) {
        const outcome = outcomes.get(target.key);
        if (!outcome || engine.isChildDone(target)) continue;
        target.status = outcome;
        target.error = reason;
        target.endedAt = nowIso();
      }
      engine.noteEvent(current, "fanout_canceled", step.id, `${outcomes.size} child run(s) stopped: ${reason}`, nowIso());
    });
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
    const loaded = await loadPlaybooks(run.workspaceDir, { projectId: run.projectId });
    const entry = lookup(loaded.entries, step.handoff ?? "");
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
      batches: [],
      failedRides: {},
      // A hand-off gives the job away: the pipeline owns it (ADR 2026-11-12-handoff-gives-the-task-away). Only jobs of older runs are not detached.
      detached: true,
      requeued: null,
      requeues: {},
      followUps: [],
    };
    await this.store.mutate(pipeline.id, (current) => engine.addJob(current, job, nowIso()));
    await this.store.mutate(run.id, (current) => {
      const attempt = current.steps[stepId]!.attempts.at(-1)!;
      if (attempt.agentId !== attemptId) return;
      attempt.job = { runId: pipeline.id, jobId: job.id };
      attempt.lastMessage = `Handed off to "${pipeline.playbook.title}" (${job.id}).`;
    });
    // The step is done now; the job is the pipeline's from here on.
    await this.finishHandoff(run.id, stepId, attemptId, { outcome: step.outcomes[0]!, summary: `Handed off to "${pipeline.playbook.title}" (${job.id}, pipeline ${pipeline.id}); this run does not wait for it.`, outputs: {} });
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
    const branch = worktreeBranch(playbook.id, id);
    const created = await this.api().workspaces.create({
      title: playbook.title,
      source: { kind: "worktree", cwd: sourceDir, action: "branch-off", branchName: branch, ...(ref ? { refName: ref } : {}) },
    });
    const workspace = await this.api().workspaces.ref(created.id).refresh();
    const workspaceDir = workspace?.workspaceDirectory ?? sourceDir;
    const entry = lookup((await loadPlaybooks(workspaceDir, { projectId })).entries, playbook.id);
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

  /** The batches (runs) of a pipeline, newest first. */
  private batchesOf(pipelineId: string): Run[] {
    return this.store.list().filter((run) => run.batch?.pipelineId === pipelineId);
  }

  /** Each free stage of each active pipeline takes its next batch from its waiting list. */
  private async startBatches(): Promise<void> {
    for (const pipeline of this.store.list()) {
      if (!isPipeline(pipeline) || isTerminal(pipeline.status) || isPaused(pipeline)) continue;
      const busy = new Set(this.batchesOf(pipeline.id).filter((batch) => !isTerminal(batch.status)).map((batch) => batch.batch!.stage));
      const due = (pipeline.playbook.singleton?.stages ?? []).filter((stage) => !busy.has(stage.id) && engine.nextBatchJobs(pipeline, stage.id).length > 0);
      if (due.length === 0) continue;
      // Between batches, the workspace follows its branch: a merged change applies from the next batch.
      if (busy.size === 0) await this.refreshPipeline(pipeline.id);
      for (const stage of due) {
        await this.startBatch(pipeline.id, stage.id).catch((error: unknown) => console.error(`[playbooks] batch of "${stage.id}" in ${pipeline.id} could not start:`, errorText(error)));
      }
    }
  }

  /** Fast-forwards an idle pipeline's workspace and reads its playbook again; jobs at a stage that is gone fail. */
  private async refreshPipeline(pipelineId: string): Promise<void> {
    const pipeline = this.store.get(pipelineId)!;
    const ref = pipeline.playbook.singleton?.branch ?? (await defaultBranch(pipeline.workspaceDir));
    if (ref) await fastForward(pipeline.workspaceDir, ref);
    const entry = lookup((await loadPlaybooks(pipeline.workspaceDir, { projectId: pipeline.projectId })).entries, pipeline.playbook.id);
    if (!entry?.playbook?.singleton) return;
    const playbook = entry.playbook;
    const ended = await this.store.mutate(pipelineId, (current) => {
      current.playbook = playbook;
      const stages = new Set(playbook.singleton!.stages.map((stage) => stage.id));
      const lost = current.jobs.filter((job) => job.status === "open" && job.waiting.some((place) => !stages.has(place.stage))).map((job) => job.id);
      return engine.failJobs(current, lost, "its stage was removed from the playbook", nowIso());
    });
    for (const job of ended) await this.deliverJob(job, { outcome: "failure", summary: job.summary ?? "stage removed", outputs: {} });
  }

  /** Starts a stage's next batch: a fresh manager in the pipeline's workspace, and a run of the stage carrying its jobs. */
  private async startBatch(pipelineId: string, stageId: string): Promise<void> {
    const pipeline = this.store.get(pipelineId)!;
    const jobs = engine.nextBatchJobs(pipeline, stageId);
    if (jobs.length === 0) return;
    const playbook = engine.stagePlaybook(pipeline.playbook, stageId);
    const manager = await this.api().workspaces.ref(pipeline.workspaceId).agents.create({
      config: this.managerConfig(playbook, await this.managerSkips(playbook, engine.activeExhausted(pipeline))),
      title: `Playbook Manager · ${playbook.title}`,
      labels: { [MANAGER_LABEL]: "true" },
    });
    const previous = this.batchesOf(pipelineId).find((batch) => batch.batch!.stage === stageId);
    const batch = engine.newBatchRun({ id: `run_${shortId()}`, pipeline, stage: stageId, jobs, managerAgentId: manager.id, now: nowIso() });
    await this.store.create(batch);
    await this.store.mutate(pipelineId, (current) => engine.joinBatch(current, stageId, batch.id, jobs.map((job) => job.id), nowIso()));
    // The stage's previous batch manager is done: one manager per stage in the workspace.
    if (previous && previous.managerAgentId !== manager.id) await this.retireManager(previous.managerAgentId, previous.id);
    for (const job of jobs) await this.noteHandoff(job, `On the "${stageId}" batch (${batch.id}) of "${pipeline.playbook.title}", with ${jobs.length} job(s).`);
    const started = this.store.get(batch.id)!;
    await manager.send(singletonKickoff(started, engine.readySteps(started)));
    this.busyManagers.add(manager.id);
    this.tickAgain = true;
  }

  /**
   * Archives a previous batch's manager, after its current turn: it is often still in the
   * complete_step call that ended its batch, and archiving it there fails that call.
   */
  private async retireManager(agentId: string, batchRunId?: string): Promise<void> {
    // The manager of a batch that settled detached jobs with an outcome is the only one who can start their follow-up: it stays
    // until each has one recorded (or it was reminded FOLLOW_UP_REMINDERS times; see chaseFollowUps).
    if (batchRunId && this.followUpsPending(batchRunId).length > 0 && (this.followUpReminders.get(batchRunId) ?? 0) < FOLLOW_UP_REMINDERS) {
      this.heldManagers.set(agentId, batchRunId);
      return;
    }
    this.heldManagers.delete(agentId);
    this.retiredManagers.add(agentId);
    if (!this.busyManagers.has(agentId)) await this.archiveStepAgent(agentId);
  }

  /** The detached jobs this batch settled with an outcome that still have no follow-up recorded. */
  private followUpsPending(batchRunId: string): Job[] {
    const batch = this.store.get(batchRunId);
    const pipeline = batch?.batch ? this.store.get(batch.batch.pipelineId) : undefined;
    return batch && pipeline ? engine.pendingFollowUps(pipeline, batch) : [];
  }

  /**
   * A batch that ended with detached jobs settled with an outcome and no follow-up (ADR 2026-11-12-pending-follow-ups): its manager
   * is reminded (up to FOLLOW_UP_REMINDERS times, each time it is idle) and, if its retirement was held, retired once
   * every job has a follow-up or the reminders ran out. The batch's jobs stay visible as "hand-off pending".
   */
  private async chaseFollowUps(): Promise<void> {
    for (const batch of this.store.list()) {
      if (!batch.batch || !isTerminal(batch.status)) continue;
      const held = this.heldManagers.get(batch.managerAgentId) === batch.id;
      const pending = this.followUpsPending(batch.id);
      const sent = this.followUpReminders.get(batch.id) ?? 0;
      if (pending.length === 0 || sent >= FOLLOW_UP_REMINDERS || batch.status === "canceled") {
        if (held) await this.retireManager(batch.managerAgentId);
        continue;
      }
      if (!batch.managerAgentId || this.busyManagers.has(batch.managerAgentId) || this.retiredManagers.has(batch.managerAgentId) || batch.inbox.length > 0) continue;
      const manager = await this.api().agents.ref(batch.managerAgentId).refresh().catch(() => null);
      if (!manager || manager.agent.archivedAt) {
        this.followUpReminders.set(batch.id, FOLLOW_UP_REMINDERS);
        continue;
      }
      this.followUpReminders.set(batch.id, sent + 1);
      const lines = pending.map((job) => `- ${job.id} (${job.label}): ${job.outcome}${job.summary ? `, ${job.summary.slice(0, 200)}` : ""}`);
      await this.enqueue(batch.id, [
        `Batch ${batch.id} ended, but ${pending.length} job(s) it settled were handed off without waiting (detached) and nobody was told: no follow-up is recorded for them, and you are the only one who can start it (reminder ${sent + 1}/${FOLLOW_UP_REMINDERS}). Do not end your turn before each has one:\n${lines.join("\n")}\nFor each, per your playbook's instructions, start the follow-up with start_playbook (newWorkspace: true, forJob: "<jobId>": the plugin records the run you started), or, when none is needed, call record_followup ({ runId: "${batch.id}", jobId, note: "why" }). get_run on the pipeline shows each job's followUps: do not start one that already has a run.`,
      ]);
      await this.deliver(batch.id);
    }
  }

  /** Finds the pipeline that owns a job, by id. */
  private pipelineOfJob(jobId: string): Run {
    const pipeline = this.store.list().find((run) => isPipeline(run) && run.jobs.some((job) => job.id === jobId));
    if (!pipeline) throw new UserError(`no pipeline has a job "${jobId}" (get_run on a batch lists its jobs)`);
    return pipeline;
  }

  /** Checks, without changing anything, that a follow-up can be recorded for the job (start_playbook forJob checks it before it starts a run). */
  checkFollowUp(jobId: string): void {
    const pipeline = this.pipelineOfJob(jobId);
    try {
      engine.recordFollowUp(structuredClone(pipeline), jobId, { runId: null, note: "check", by: null, now: nowIso() });
    } catch (error) {
      if (error instanceof engine.EngineError) throw new UserError(error.message);
      throw error;
    }
  }

  /** record_followup / start_playbook forJob: what was done for a detached job that ended with an outcome. */
  async recordFollowUp(jobId: string, input: { runId: string | null; note: string | null; by: string | null }, scope?: string): Promise<{ pipeline: Run; job: Job }> {
    const pipeline = this.pipelineOfJob(jobId);
    if (scope) {
      const given = this.store.get(scope);
      if (!given) throw new UserError(`unknown run "${scope}"`);
      if ((given.batch ? given.batch.pipelineId : given.id) !== pipeline.id) throw new UserError(`job ${jobId} belongs to pipeline ${pipeline.id}, not to run ${scope}`);
    }
    try {
      const job = await this.store.mutate(pipeline.id, (current) => engine.recordFollowUp(current, jobId, { ...input, now: nowIso() }));
      for (const batch of this.store.list().filter((candidate) => candidate.batch?.pipelineId === pipeline.id && candidate.jobs.some((copy) => copy.id === jobId))) {
        await this.store.mutate(batch.id, (current) => engine.mirrorJob(current, job));
      }
      await this.chaseFollowUps();
      return { pipeline: this.store.get(pipeline.id)!, job };
    } catch (error) {
      if (error instanceof engine.EngineError) throw new UserError(error.message);
      throw error;
    }
  }

  /**
   * Tells the runs whose jobs ride a batch when it waits for a human (a gate or an ask), and
   * again when that is decided (or the batch ends first): their managers pass it on where they
   * report. The decision stays with the batch, in the Playbooks panel.
   */
  private async noticeBatchGates(): Promise<void> {
    for (const batch of this.store.list()) {
      if (!batch.batch) continue;
      const pipeline = this.store.get(batch.batch.pipelineId);
      if (!pipeline) continue;
      const jobs = pipeline.jobs.filter((job) => job.batches.some((ride) => ride.runId === batch.id));
      const where = `the "${batch.batch.stage}" batch (${batch.id}) of "${pipeline.playbook.title}"`;
      for (const gate of batch.gates) {
        const key = `${batch.id}/${gate.id}`;
        // A gate its role decides is announced only if the role leaves it to a human.
        const pending = waitsForHuman(gate) && !isTerminal(batch.status);
        if (pending === this.batchGates.has(key)) continue;
        let text: string;
        if (pending) {
          this.batchGates.add(key);
          const others = jobs.length > 1 ? ` (and ${jobs.length - 1} other job(s))` : "";
          text = `${where}, which carries your job${others}, waits for a human at ${gate.kind === "ask" ? "the ask of" : "gate"} ${gate.stepId}: ${gate.message} It is decided in the Playbooks panel (the "${pipeline.playbook.title}" card), not with resume: pass it on where you report. You are told when it is decided.`;
        } else {
          this.batchGates.delete(key);
          const comment = gate.comment ? `: "${gate.comment}"` : "";
          text = gate.status === "pending" ? `${gate.stepId} of ${where} no longer waits: the batch ${batch.status}.` : `${gate.stepId} of ${where} was decided: ${gate.status} by ${gate.decidedBy ?? "a human"}${comment}.`;
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
   * Batches that ended move their jobs on (next stages, out of the pipeline, back to the waiting
   * list, or failed); a pipeline that ended fails its open jobs and cancels its batches. The
   * hand-offs of jobs that ended are told.
   */
  private async endBatches(): Promise<void> {
    for (const batch of this.store.list()) {
      if (!batch.batch || !isTerminal(batch.status)) continue;
      const pipeline = this.store.get(batch.batch.pipelineId);
      if (!pipeline || !pipeline.jobs.some((job) => job.batches.some((ride) => ride.runId === batch.id))) continue;
      const ended = await this.store.mutate(pipeline.id, (current) => engine.batchEnded(current, batch, nowIso()));
      for (const job of ended) {
        // A job that passed every stage yet failed (missing outputs) shipped: its hand-off is never retried.
        const shipped = job.status === "failed" && engine.stagesOf(pipeline).every((stage) => job.passed.includes(stage.id));
        await this.deliverJob(job, job.status === "settled" ? { outcome: job.outcome!, summary: job.summary ?? "", outputs: job.outputs } : { outcome: "failure", summary: job.summary ?? "", outputs: {} }, shipped);
      }
      for (const job of this.store.get(pipeline.id)!.jobs.filter((candidate) => candidate.status === "open")) {
        const next = job.waiting.map((place) => `"${place.stage}"`).join(", ");
        if (next) await this.noteHandoff(job, `Waiting at ${next} of "${pipeline.playbook.title}".`);
      }
      this.tickAgain = true;
    }
    for (const pipeline of this.store.list()) {
      if (!isPipeline(pipeline) || !isTerminal(pipeline.status)) continue;
      for (const batch of this.batchesOf(pipeline.id).filter((candidate) => !isTerminal(candidate.status))) {
        await this.cancelRun(batch.id, `its pipeline ${pipeline.id} is ${pipeline.status}`, null).catch(() => undefined);
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

  /** A hand-off step was canceled, reset or timed out: its job leaves the pipeline, and the batches carrying it are told. */
  private async withdrawHandoff(fromRunId: string, attemptId: string, reason: string): Promise<void> {
    this.clearTimeout(attemptId);
    const from = this.store.get(fromRunId);
    const attempt = from && Object.values(from.steps).flatMap((state) => state.attempts).find((candidate) => candidate.agentId === attemptId);
    if (!attempt?.job || !this.store.get(attempt.job.runId)) return;
    // A detached job belongs to the pipeline: nothing its run does withdraws it.
    if (this.store.get(attempt.job.runId)!.jobs.find((job) => job.id === attempt.job!.jobId)?.detached) return;
    const withdrawn = await this.store.mutate(attempt.job.runId, (current) => engine.withdrawJob(current, attempt.job!.jobId, reason, nowIso()));
    if (!withdrawn) return;
    for (const batchId of withdrawn.batches) {
      const batch = this.store.get(batchId);
      if (!batch) continue;
      await this.store.mutate(batchId, (current) => engine.mirrorJob(current, withdrawn.job));
      if (isTerminal(batch.status)) continue;
      await this.enqueue(batchId, [`Job ${withdrawn.job.id} (from ${withdrawn.job.label}) was withdrawn: ${reason}. Leave it out of the rest of the batch; it no longer needs settle_job.`]);
      await this.deliver(batchId);
    }
  }

  /**
   * requeue_job: a failed, detached job of a pipeline waits again at its stages, with the same id. `runId` is the pipeline,
   * or one of its batches. Idempotent: an open job is left as it is. Any agent may call it (like cancel_run).
   */
  async requeueJob(runId: string, jobId: string, reason: string): Promise<{ pipeline: Run; job: Job; changed: boolean }> {
    const given = this.store.get(runId);
    if (!given) throw new UserError(`unknown run "${runId}"`);
    const pipeline = given.batch ? this.store.get(given.batch.pipelineId) : given;
    if (!pipeline) throw new UserError(`the pipeline of batch ${given.id} no longer exists`);
    if (!isPipeline(pipeline)) throw new UserError(`run ${pipeline.id} is not a singleton pipeline: it carries no jobs`);
    try {
      const result = await this.store.mutate(pipeline.id, (current) => engine.reopenJob(current, jobId, reason, nowIso()));
      if (result.changed) await this.tick();
      return { pipeline: this.store.get(pipeline.id)!, ...result };
    } catch (error) {
      if (error instanceof engine.EngineError) throw new UserError(error.message);
      throw error;
    }
  }

  /** A batch's manager settles one of its jobs: sets its outputs, or ends it (its hand-off is told at once). */
  async settleJob(managerId: string, runId: string, jobId: string, input: { outcome?: string | undefined; summary: string; outputs: Record<string, unknown>; blocker?: string | undefined }): Promise<Run> {
    const batch = this.ownedRun(managerId, runId);
    if (!batch.batch) throw new UserError(`run ${batch.id} is not a batch of a singleton pipeline: it carries no job`);
    if (isTerminal(batch.status)) throw new UserError(`batch ${batch.id} is ${batch.status}`);
    const pipelineId = batch.batch.pipelineId;
    if (!this.store.get(pipelineId)) throw new UserError(`the pipeline of batch ${batch.id} no longer exists`);
    const settled = await this.store.mutate(pipelineId, (current) => engine.settleJob(current, batch.id, jobId, { ...input, now: nowIso() }));
    await this.store.mutate(batch.id, (current) => engine.mirrorJob(current, settled.job));
    if (settled.ended) await this.deliverJob(settled.job, settled.job.status === "settled" ? { outcome: settled.job.outcome!, summary: settled.job.summary ?? "", outputs: settled.job.outputs } : { outcome: "failure", summary: settled.job.summary ?? "", outputs: {} });
    return this.store.get(batch.id)!;
  }

  /**
   * Checks a batch step's `settle` output before the step completes: every entry must apply to
   * the pipeline as it is (tried on a copy). Returns the entries; throws with what is wrong.
   */
  private checkSettle(batch: Run, step: Step, value: unknown): { results: engine.JobResult[]; pipeline: Run | null } {
    if (!batch.batch || !step.settle) return { results: [], pipeline: null };
    const pipeline = this.store.get(batch.batch.pipelineId);
    if (!pipeline) throw new UserError(`the pipeline of batch ${batch.id} no longer exists`);
    const where = `settle.output "${step.settle.output}" of "${step.id}"`;
    try {
      const results = engine.parseJobResults(typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));
      const copy = structuredClone(pipeline);
      for (const result of results) {
        if (result.outcome === undefined && Object.keys(result.outputs).length === 0) continue;
        engine.settleJob(copy, batch.id, result.jobId, { ...result, now: nowIso() });
      }
      return { results, pipeline: copy };
    } catch (error) {
      throw new UserError(`${where}: ${errorText(error)}. Fix the entries (one per job id: \`{ outputs: {...}, outcome?, reason? }\`) and complete the step again.`);
    }
  }

  /**
   * A batch step with `settle` completed: the plugin settles its jobs from that output, as
   * settle_job would (outputs set, or the job ended and its hand-off told). Returns problems.
   */
  private async applySettle(batchId: string, stepId: string, value?: unknown): Promise<string[]> {
    const batch = this.store.get(batchId);
    if (!batch?.batch) return [];
    const step = engine.stepDef(batch, stepId);
    if (!step.settle) return [];
    const state = batch.steps[stepId]!;
    const attempt = state.attempts.at(-1);
    if (!attempt?.outcome || !engine.completesStep(step, attempt.outcome)) return [];
    const key = `${batchId}/${stepId}/${attempt.n}`;
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
        const settled = await this.store.mutate(batch.batch.pipelineId, (current) => engine.settleJob(current, batchId, result.jobId, { ...result, now: nowIso() }));
        await this.store.mutate(batchId, (current) => engine.mirrorJob(current, settled.job));
        if (settled.ended) await this.deliverJob(settled.job, settled.job.status === "settled" ? { outcome: settled.job.outcome!, summary: settled.job.summary ?? "", outputs: settled.job.outputs } : { outcome: "failure", summary: settled.job.summary ?? "", outputs: {} });
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
        this.runCheck(run.id, stepId, started.id, "first");
      }
    }
  }

  /** Runs the script once in the run's worktree. "Not yet" schedules the next check; anything else ends the attempt. */
  private runCheck(runId: string, stepId: string, attemptId: string, trigger: string): void {
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || attempt?.agentId !== attemptId || run.steps[stepId]!.status !== "running") return this.stopScript(attemptId);
    const step = engine.stepDef(run, stepId);
    if (step.wakeOn && !this.wakers.has(attemptId)) {
      this.wakers.set(attemptId, {
        runId,
        stepId,
        rules: step.wakeOn.map((rule) => ({ types: rule.types.map(globToRegExp), filter: Object.entries(rule.filter) })),
        busy: false,
        dirty: null,
        gapWait: false,
        endedAt: 0,
      });
    }
    const waker = this.wakers.get(attemptId);
    if (waker) {
      // Events before this start are covered by this check.
      waker.busy = true;
      waker.dirty = null;
      waker.gapWait = false;
    }
    const slot = { child: null as ChildProcess | null, next: null as ReturnType<typeof setTimeout> | null };
    this.scripts.set(attemptId, slot);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const live = this.scriptLive.get(attemptId) ?? { runningSince: null, trigger: null, tail: "", checks: [] };
    this.scriptLive.set(attemptId, live);
    live.runningSince = nowIso();
    live.trigger = trigger;
    live.tail = "";
    const done = (exit: { code: number | null; signal: string | null }, spawnError?: string) => {
      if (settled) return;
      settled = true;
      slot.child = null;
      // Stopped (canceled, reset by a goto, timed out): whoever stopped it owns the attempt now.
      if (this.scripts.get(attemptId) !== slot) return;
      const result = spawnError
        ? { outcome: "failure", summary: `${step.script}: ${spawnError}`, outputs: {} }
        : scriptResult(step, exit, stdout, stderr);
      live.checks.push({
        n: (attempt.checks ?? 0) + 1,
        startedAt: live.runningSince ?? nowIso(),
        endedAt: nowIso(),
        outcome: typeof result === "string" ? result : result.outcome,
        exitCode: exit.code,
        tail: tailOf([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")),
        trigger,
      });
      if (live.checks.length > SCRIPT_CHECKS_KEPT) live.checks.splice(0, live.checks.length - SCRIPT_CHECKS_KEPT);
      live.runningSince = null;
      live.trigger = null;
      live.tail = "";
      if (waker) waker.endedAt = Date.now();
      this.onCheckEnded(runId, stepId, attemptId, result, tailOf([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"))).catch((error: unknown) => console.error(`[playbooks] script check of "${stepId}" failed:`, error));
    };
    try {
      // An isolated run's scripts run in its worktree; one the worktree's commit lacks (uncommitted in the workspace) runs from the workspace.
      const inWorktree = run.worktree ? path.join(run.worktree.path, step.script!) : null;
      const child = spawn(inWorktree && existsSync(inWorktree) ? inWorktree : path.join(run.workspaceDir, step.script!), [], {
        cwd: engine.workDir(run),
        env: scriptEnv(run, stepId, attempt, this.scriptFeedback.get(attemptId) ?? null),
        stdio: ["ignore", "pipe", "pipe"],
      });
      slot.child = child;
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout = tailOf(stdout + chunk.toString());
        live.tail = tailOf(live.tail + chunk.toString());
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = tailOf(stderr + chunk.toString());
        live.tail = tailOf(live.tail + chunk.toString());
      });
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
      slot.next = setTimeout(() => this.runCheck(runId, stepId, attemptId, "poll"), step.pollMs!);
      (slot.next as unknown as { unref?: () => void }).unref?.();
      const waker = this.wakers.get(attemptId);
      if (waker) {
        waker.busy = false;
        // An event came in while the check ran: one more check, after the gap, instead of the poll.
        if (waker.dirty) await this.scheduleWake(attemptId, waker, waker.dirty);
      }
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
      // A bad outcome or outputs line is the script's failure, not a reason to hang or to throw.
      engine.recordAutomaticReport(run, attemptId, result, nowIso());
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
      if ((step.kind !== "script" && step.kind !== "handoff" && step.kind !== "fanout") || state.status !== "reported" || !isStepLive(this.store.get(runId)!, step.id)) continue;
      const attempt = state.attempts.at(-1)!;
      const kind = step.kind === "script" ? "script step" : step.kind === "fanout" ? "fan-out step" : "hand-off step";
      const report = attempt.report ?? { outcome: "failure", summary: `${step.script ?? step.handoff ?? step.fanout?.playbook} ended without a result`, outputs: {} };
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
        `${kind} "${step.id}" attempt ${attempt.n} ended ${report.outcome}${step.kind === "script" ? ` after ${attempt.checks} check(s)` : step.kind === "fanout" ? ` (runs of "${step.fanout!.playbook}")` : ` (job of "${step.handoff}")`}: ${report.summary}${Object.keys(report.outputs).length ? ` Outputs: ${JSON.stringify(report.outputs)}.` : ""}`,
        "The plugin completed it; do not call complete_step for it.",
        ...effects.notes,
        isActive(after) && ready.length > 0 ? `Ready: ${ready.join(", ")}. Start them with start_step (or request_gate for a gate).` : "",
        isTerminal(after.status) && !isActive(after) ? `The run is ${after.status}. Tell the human.` : "",
      ].filter(Boolean));
    }
    await this.deliver(runId);
  }

  /** The live output of a script step's current attempt, for the panel. Empty after a daemon restart. */
  scriptOutput(runId: string, stepId: string): ScriptOutput {
    const attempt = this.store.get(runId)?.steps[stepId]?.attempts.at(-1);
    const live = attempt ? this.scriptLive.get(attempt.agentId ?? "") : undefined;
    if (!attempt || !live) return { running: false, since: null, tail: "", checks: [] };
    return { running: live.runningSince !== null, since: live.runningSince, tail: live.tail, ...(live.trigger ? { trigger: live.trigger } : {}), checks: live.checks.map((check) => ({ ...check })) };
  }

  /**
   * The bus listener of `script.wake_on` (ADR 2026-11-12-script-wake-on). An event that matches a waiting script step
   * runs its check now; during a check it only marks the step, which then runs once more (a burst is one extra check).
   * Events about the script's own step (same run and stepId) are not delivered to it. Nothing is emitted back.
   */
  private wakeScripts(event: BusEvent): void {
    for (const [attemptId, waker] of this.wakers) {
      if (event.runId === waker.runId && event.payload.stepId === waker.stepId) continue;
      const hit = waker.rules.some((rule) => rule.types.some((type) => type.test(event.type)) && rule.filter.every(([key, value]) => event.payload[key] === value));
      if (!hit) continue;
      const run = this.store.get(waker.runId);
      if (!run || run.steps[waker.stepId]?.status !== "running" || run.steps[waker.stepId]!.attempts.at(-1)?.agentId !== attemptId) {
        this.stopScript(attemptId);
        continue;
      }
      if (waker.busy) waker.dirty ??= event.type;
      else if (!waker.gapWait) void this.scheduleWake(attemptId, waker, event.type).catch((error: unknown) => console.error(`[playbooks] could not wake "${waker.stepId}":`, errorText(error)));
    }
  }

  /** Replaces the poll timer by a check now, or when the gap since the last one has passed. */
  private async scheduleWake(attemptId: string, waker: Waker, type: string): Promise<void> {
    const slot = this.scripts.get(attemptId);
    if (!slot || slot.child || waker.gapWait) return;
    if (slot.next) clearTimeout(slot.next);
    waker.dirty = null;
    const wait = Math.max(0, waker.endedAt + (this.options.wakeGapMs ?? DEFAULT_WAKE_GAP_MS) - Date.now());
    const start = () => this.runCheck(waker.runId, waker.stepId, attemptId, `event:${type}`);
    if (wait === 0) {
      slot.next = null;
      return start();
    }
    waker.gapWait = true;
    slot.next = setTimeout(start, wait);
    (slot.next as unknown as { unref?: () => void }).unref?.();
    // The panel's "next check in" follows the wake-up, not the poll it replaced.
    const at = new Date(Date.now() + wait).toISOString();
    await this.store.mutate(waker.runId, (run) => {
      const attempt = run.steps[waker.stepId]?.attempts.at(-1);
      if (attempt?.agentId === attemptId) attempt.nextCheckAt = at;
    }).catch(() => undefined);
  }

  /** Kills a script's running check and drops its next one. */
  private stopScript(attemptId: string): void {
    const slot = this.scripts.get(attemptId);
    this.scripts.delete(attemptId);
    this.scriptFeedback.delete(attemptId);
    this.scriptLive.delete(attemptId);
    this.wakers.delete(attemptId);
    if (!slot) return;
    if (slot.next) clearTimeout(slot.next);
    slot.child?.kill("SIGTERM");
  }

  // ---------------------------------------------------------------- admission (queue.admit)

  /**
   * Starts the admission check of every stage that has waiting jobs and none tracked, and drops the ones with nothing
   * to look at (an empty queue costs no check) or whose pipeline or `admit` block is gone. The script is not in a
   * batch: no run, no manager, no agent. After a daemon restart this is what runs the check again (it is idempotent).
   */
  private async driveAdmissions(): Promise<void> {
    for (const [key, admission] of [...this.admissions]) {
      const pipeline = this.store.get(admission.pipelineId);
      const stage = pipeline && !isTerminal(pipeline.status) ? engine.stagesOf(pipeline).find((candidate) => candidate.id === admission.stageId) : undefined;
      if (!pipeline || !stage?.admit || (!admission.busy && engine.admissionJobs(pipeline, admission.stageId).length === 0)) this.dropAdmission(key);
    }
    for (const pipeline of this.store.list()) {
      if (!isPipeline(pipeline) || isTerminal(pipeline.status) || isPaused(pipeline)) continue;
      for (const stage of engine.stagesOf(pipeline)) {
        const key = `${pipeline.id}/${stage.id}`;
        if (!stage.admit || this.admissions.has(key) || engine.admissionJobs(pipeline, stage.id).length === 0) continue;
        this.admissions.set(key, { pipelineId: pipeline.id, stageId: stage.id, busy: false, dirty: null, gapWait: false, endedAt: 0, child: null, next: null, status: idleAdmission() });
        void this.runAdmission(key, "first").catch((error: unknown) => console.error(`[playbooks] admission check of "${stage.id}" in ${pipeline.id} failed:`, errorText(error)));
      }
    }
  }

  private dropAdmission(key: string): void {
    const admission = this.admissions.get(key);
    this.admissions.delete(key);
    if (!admission) return;
    if (admission.next) clearTimeout(admission.next);
    admission.child?.kill("SIGTERM");
  }

  /** Runs the stage's admission script once with its waiting jobs; `onAdmissionChecked` applies what it said. */
  private async runAdmission(key: string, trigger: string): Promise<void> {
    const admission = this.admissions.get(key);
    if (!admission) return;
    let pipeline = this.store.get(admission.pipelineId);
    const stage = pipeline && !isTerminal(pipeline.status) ? engine.stagesOf(pipeline).find((candidate) => candidate.id === admission.stageId) : undefined;
    if (!pipeline || !stage?.admit) return this.dropAdmission(key);
    if (isPaused(pipeline)) return this.armAdmissionPoll(admission, stage.admit.pollMs);
    const given = admissionInput(pipeline, stage.id);
    // An empty queue costs no check.
    if (given.jobs.length === 0) return this.dropAdmission(key);
    const sent = given.jobs.map((job) => job.id);
    admission.busy = true;
    admission.dirty = null;
    admission.gapWait = false;
    admission.next = null;
    const status = admission.status;
    status.running = true;
    status.since = nowIso();
    status.trigger = trigger;
    status.tail = "";
    status.nextCheckAt = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: ReturnType<typeof readAdmission>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      admission.child = null;
      // Dropped (the queue emptied, the pipeline ended): whoever dropped it owns the slot now.
      if (this.admissions.get(key) !== admission) return;
      const output = tailOf([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"));
      this.onAdmissionChecked(key, admission, sent, outcome, output).catch((error: unknown) => console.error(`[playbooks] admission check of "${stage.id}" in ${admission.pipelineId} failed:`, errorText(error)));
    };
    try {
      // The pipeline's workspace is where its scripts live; one a newer commit added is read once the pipeline is between batches.
      let file = path.join(pipeline.workspaceDir, stage.admit.script);
      if (!existsSync(file) && existsSync(pipeline.workspaceDir) && !this.batchesOf(pipeline.id).some((batch) => !isTerminal(batch.status))) {
        const id = pipeline.id;
        await this.refreshPipeline(id).catch((error: unknown) => console.error(`[playbooks] could not refresh ${id}:`, errorText(error)));
        pipeline = this.store.get(id)!;
        file = path.join(pipeline.workspaceDir, stage.admit.script);
      }
      if (!existsSync(pipeline.workspaceDir)) return finish({ kind: "failed", message: `the pipeline's workspace ${pipeline.workspaceDir} does not exist` });
      if (!existsSync(file)) return finish({ kind: "failed", message: `${stage.admit.script} not found in the pipeline's workspace ${pipeline.workspaceDir}` });
      const child = spawn(file, [], {
        cwd: pipeline.workspaceDir,
        env: {
          ...process.env,
          PLAYBOOK_RUN_ID: pipeline.id,
          PLAYBOOK_STEP_ID: stage.id,
          PLAYBOOK_STAGE: stage.id,
          /** Deprecated name of PLAYBOOK_STAGE (ADR 2026-11-12-stage-batch-rename). */
          PLAYBOOK_STATION: stage.id,
          PLAYBOOK_PIPELINE: pipeline.playbook.id,
          PLAYBOOK_CHECK: String(status.checks + 1),
          PLAYBOOK_WORKSPACE: pipeline.workspaceDir,
          PLAYBOOK_JOBS: JSON.stringify(given.jobs),
          PLAYBOOK_JOBS_OMITTED: String(given.omitted),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      admission.child = child;
      const limit = this.options.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS;
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ kind: "failed", message: `timed out after ${formatMinutes(limit)}` });
      }, limit);
      (timer as unknown as { unref?: () => void }).unref?.();
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout = tailOf(stdout + chunk.toString());
        status.tail = tailOf(status.tail + chunk.toString());
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = tailOf(stderr + chunk.toString());
        status.tail = tailOf(status.tail + chunk.toString());
      });
      child.on("error", (error) => finish({ kind: "failed", message: errorText(error) }));
      child.on("close", (code, signal) => finish(readAdmission({ code, signal }, stdout, stderr)));
    } catch (error) {
      finish({ kind: "failed", message: errorText(error) });
    }
  }

  /** A check ended: a result is applied to the queue; "not yet" and a failure change nothing (a failure shows in the panel). */
  private async onAdmissionChecked(key: string, admission: Admission, sent: string[], outcome: ReturnType<typeof readAdmission>, output: string): Promise<void> {
    const status = admission.status;
    status.running = false;
    status.since = null;
    status.trigger = null;
    status.tail = "";
    status.checks += 1;
    status.lastCheckAt = nowIso();
    admission.endedAt = Date.now();
    if (outcome.kind === "failed") {
      status.lastOutcome = "failed";
      status.error = { at: nowIso(), message: outcome.message, tail: output };
      console.warn(`[playbooks] admission check of "${admission.stageId}" in ${admission.pipelineId} failed: ${outcome.message}`);
    } else {
      status.lastOutcome = outcome.kind === "not_yet" ? "not_yet" : "ok";
      status.error = null;
      status.warnings = [];
      if (outcome.kind === "result" && this.store.get(admission.pipelineId)) {
        const applied = await this.store.mutate(admission.pipelineId, (current) => engine.applyAdmission(current, admission.stageId, sent, outcome.result, nowIso()));
        status.warnings = applied.warnings;
        for (const warning of applied.warnings) console.warn(`[playbooks] admission check of "${admission.stageId}" in ${admission.pipelineId}: ${warning}`);
      }
    }
    admission.busy = false;
    const pipeline = this.store.get(admission.pipelineId);
    const stage = pipeline ? engine.stagesOf(pipeline).find((candidate) => candidate.id === admission.stageId) : undefined;
    if (this.admissions.get(key) === admission && stage?.admit) {
      // An event (or a retry) came in during the check: one more, after the gap; else the poll.
      if (admission.dirty) this.scheduleAdmissionWake(admission, admission.dirty);
      else this.armAdmissionPoll(admission, stage.admit.pollMs);
    }
    // Admitted jobs may join; an emptied queue drops its check.
    await this.tick();
  }

  private armAdmissionPoll(admission: Admission, pollMs: number): void {
    if (admission.next) clearTimeout(admission.next);
    const key = `${admission.pipelineId}/${admission.stageId}`;
    admission.next = setTimeout(() => void this.runAdmission(key, "poll").catch((error: unknown) => console.error("[playbooks] admission check failed:", errorText(error))), pollMs);
    (admission.next as unknown as { unref?: () => void }).unref?.();
    admission.status.nextCheckAt = new Date(Date.now() + pollMs).toISOString();
  }

  /** The bus listener of a stage's admission: its own queue's `job.queued`, and the stages' `wake_on` rules. */
  private wakeAdmissions(event: BusEvent): void {
    for (const [key, admission] of this.admissions) {
      const pipeline = this.store.get(admission.pipelineId);
      const stage = pipeline ? engine.stagesOf(pipeline).find((candidate) => candidate.id === admission.stageId) : undefined;
      if (!stage?.admit) continue;
      const own = event.runId === admission.pipelineId && event.payload.stage === admission.stageId;
      // What the check itself does (hold, admit, escalate) does not wake it.
      if (own && ["job.held", "job.admitted", "job.escalated"].includes(event.type)) continue;
      const hit =
        (own && event.type === "job.queued") ||
        stage.admit.wakeOn.some((rule) => rule.types.some((type) => globToRegExp(type).test(event.type)) && Object.entries(rule.filter).every(([field, value]) => event.payload[field] === value));
      if (!hit) continue;
      if (admission.busy) admission.dirty ??= event.type;
      else if (!admission.gapWait) this.scheduleAdmissionWake(admission, event.type, key);
    }
  }

  /** Replaces the poll timer by a check now (a retry), or when the gap since the last one has passed. */
  private scheduleAdmissionWake(admission: Admission, type: string, key = `${admission.pipelineId}/${admission.stageId}`): void {
    if (admission.child || (admission.gapWait && type !== "retry")) return;
    if (admission.next) clearTimeout(admission.next);
    admission.gapWait = false;
    admission.dirty = null;
    const gap = this.options.wakeGapMs ?? DEFAULT_WAKE_GAP_MS;
    const wait = type === "retry" ? 0 : Math.max(0, admission.endedAt + gap - Date.now());
    const trigger = type === "retry" ? "retry" : `event:${type}`;
    const start = () => void this.runAdmission(key, trigger).catch((error: unknown) => console.error("[playbooks] admission check failed:", errorText(error)));
    if (wait === 0) {
      admission.next = null;
      return start();
    }
    admission.gapWait = true;
    admission.next = setTimeout(start, wait);
    (admission.next as unknown as { unref?: () => void }).unref?.();
    admission.status.nextCheckAt = new Date(Date.now() + wait).toISOString();
  }

  /** A human decided an admission gate: retry checks the queue again at once; withdraw tells the job's hand-off; admit lets it join. */
  private async afterAdmissionDecision(pipelineId: string, gate: Gate): Promise<void> {
    const pipeline = this.store.get(pipelineId);
    const job = pipeline?.jobs.find((candidate) => candidate.id === gate.jobId);
    if (gate.status === "retry") {
      const admission = this.admissions.get(`${pipelineId}/${gate.stepId}`);
      if (admission) {
        if (admission.busy) admission.dirty = "retry";
        else this.scheduleAdmissionWake(admission, "retry");
      }
    } else if (gate.status === "withdraw" && job?.status === "withdrawn") {
      await this.deliverJob(job, { outcome: "failure", summary: job.summary ?? "withdrawn from the queue", outputs: {} }, true);
    }
    await this.tick();
  }

  /** The admission checks of a pipeline's stages, for the panel: live status, in memory (idle after a daemon restart until the next check). */
  admissionStatus(runId: string): Record<string, AdmissionStatus> {
    const pipeline = this.store.get(runId);
    if (!pipeline) return {};
    return Object.fromEntries(
      engine
        .stagesOf(pipeline)
        .filter((stage) => stage.admit)
        .map((stage) => [stage.id, structuredClone(this.admissions.get(`${runId}/${stage.id}`)?.status ?? idleAdmission())]),
    );
  }

  /**
   * start_playbook's autoStart: starts the new run's ready agent steps, one after the other, through startStep (same
   * model resolution, role and workspace as the manager's own call). Script, hand-off and gate steps are not started
   * here (the plugin runs the first two itself; a gate is opened with request_gate). A step that cannot start is
   * reported, not thrown: the run stays usable and the manager starts it with start_step.
   */
  async autoStartReady(managerId: string, runId: string): Promise<{ started: Array<{ stepId: string; agentId: string; attempt: number; target: string; skipped?: string[] }>; failed: Array<{ stepId: string; error: string }> }> {
    const started: Array<{ stepId: string; agentId: string; attempt: number; target: string; skipped?: string[] }> = [];
    const failed: Array<{ stepId: string; error: string }> = [];
    const run = managerId === "" ? this.store.get(runId)! : this.ownedRun(managerId, runId);
    for (const stepId of engine.readySteps(run)) {
      if (engine.stepDef(run, stepId).kind !== "agent") continue;
      try {
        started.push({ stepId, ...(await this.startStep(managerId, runId, stepId, "")) });
      } catch (error) {
        failed.push({ stepId, error: errorText(error) });
      }
    }
    return { started, failed };
  }

  async startStep(managerId: string, runId: string, stepId: string, brief: string, model?: ModelChoice): Promise<{ agentId: string; attempt: number; target: string; skipped?: string[] }> {
    // managerId "": the plugin itself, for a run with no manager (manager.mode: none); its step agents are top-level agents of the workspace.
    let run = managerId === "" ? this.store.get(runId)! : this.ownedRun(managerId, runId);
    const step = engine.stepDef(run, stepId);
    if (step.kind === "script") throw new UserError(`step "${stepId}" is a script step: the plugin runs it by itself and wakes you with its result`);
    if (step.kind === "fanout") throw new UserError(`step "${stepId}" is a fan-out step: the plugin starts the runs of "${step.fanout!.playbook}" itself and wakes you when they have all ended`);
    if (step.kind === "handoff") throw new UserError(`step "${stepId}" is a hand-off step: the plugin hands its job to "${step.handoff}" and wakes you with the result`);
    if (step.kind !== "agent" || !step.role) throw new UserError(`step "${stepId}" is a gate; call request_gate`);
    if (run.steps[stepId]!.status !== "ready") {
      throw new UserError(`step "${stepId}" is ${run.steps[stepId]!.status}, not ready (ready now: ${engine.readySteps(run).join(", ") || "none"})`);
    }
    const role = run.playbook.roles[step.role]!;
    // The manager's model, else the one restart_run left for this step, else the role's chain.
    const chosen = model ?? run.steps[stepId]!.nextModel ?? undefined;
    const skips: string[] = [];
    const config = await this.stepAgentConfig(run, step, isManagerless(run) ? MANAGERLESS_STEP_TOOL_NAMES : STEP_TOOL_NAMES, chosen ? await this.checkModel(chosen) : undefined, skips);
    if (run.worktree && (run.worktree.state !== "active" || !existsSync(run.worktree.path))) {
      // An after-task or a late step of an ended run: its worktree was deleted or kept; work needs it back.
      const worktree = await this.ensureWorktree(run, run.workspaceDir);
      await this.store.mutate(run.id, (current) => void (current.worktree = worktree));
      run = this.store.get(run.id)!;
    }
    const snapshot = role.readonly ? await checkoutSnapshot(engine.workDir(run)) : null;
    const attemptNo = run.steps[stepId]!.attempts.length + 1;
    const previous = run.steps[stepId]!.attempts.at(-1);
    const agent = await this.api()
      .workspaces.ref(run.workspaceId)
      .agents.create({
        config: { ...config, systemPrompt: stepSystemPrompt(run.playbook, step, role, run) },
        ...(managerId ? { parent: managerId } : {}),
        title: `${run.playbook.title} · ${role.title} #${attemptNo}`,
        labels: { [RUN_LABEL]: run.id, [STEP_LABEL]: stepId, "playbooks/attempt": String(attemptNo) },
      });
    const started = await this.store.mutate(run.id, (current) =>
      engine.startAttempt(current, stepId, { agentId: agent.id, brief, now: nowIso(), readonlySnapshot: snapshot }),
    );
    await this.store.mutate(run.id, (current) => {
      const attempt = engine.currentAttempt(current, stepId)!;
      attempt.target = config.provider ?? "";
      attempt.agents.push({ agentId: agent.id, target: attempt.target, at: attempt.startedAt, why: chosen ? "model" : "chain" });
      current.steps[stepId]!.nextModel = null;
    });
    await agent.send(withPreamble(started.prompt, run));
    this.armTimeout(this.store.get(run.id)!, stepId);
    // The previous attempt's agent is done: the step's history keeps its outcome.
    if (previous && step.archiveAgents !== false) await this.archiveStepAgent(previous.agentId);
    return { agentId: agent.id, attempt: started.attempt.n, target: config.provider ?? "", ...(skips.length > 0 ? { skipped: skips } : {}) };
  }

  /** The targets of a step's chain (primary first) with their resolved provider and model. */
  private async stepCandidates(run: Run, step: Pick<Step, "id" | "agent">) {
    const manager = run.managerAgentId ? await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null) : null;
    const [first, ...rest] = [
      { ...step.agent, fallback: undefined } as AgentTarget,
      ...(step.agent.fallback ?? []),
    ];
    const own = [first!, ...rest].map((target, index) => {
      const provider = target.provider ?? (index === 0 ? manager?.agent.provider : undefined) ?? DEFAULT_PROVIDER;
      const model =
        target.model ??
        (index === 0 && manager?.agent.provider === provider ? manager?.agent.model ?? undefined : undefined) ??
        (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
      return { target, provider, model };
    });
    // `providers.fallback`: after the role's own chain, skipping targets already in it.
    const seen = new Set(own.map((candidate) => `${candidate.provider}/${candidate.model}`));
    const extra = (run.playbook.fallback ?? [])
      .filter((entry) => !seen.has(entry) && seen.add(entry))
      .map((entry) => {
        const [provider, model] = splitTarget(entry);
        return { target: inheritTarget({ ...own[0]!.target, provider: own[0]!.provider }, provider, model), provider, model: model as string | undefined };
      });
    return [...own, ...extra];
  }

  /**
   * A `provider/model` the manager passed (start_step, nudge_step, restart_run): refused unless the
   * provider lists that model (list_models), and a thinking option it does not offer.
   */
  async checkModel(choice: ModelChoice): Promise<ModelChoice> {
    const [provider, model] = splitTarget(choice.target.trim());
    if (!provider || !model) throw new UserError(`model "${choice.target}": expected provider/model, such as claude/claude-opus-5-5 (see list_providers and list_models)`);
    let listed: Array<{ id: string; aliases?: string[]; thinkingOptions?: Array<{ id: string }> }> = [];
    let problem: string | null = null;
    try {
      const result = (await this.api().providers.listModels(provider as never)) as { models?: typeof listed; error?: string | null };
      listed = result.models ?? [];
      problem = result.error ?? null;
    } catch (error) {
      problem = errorText(error);
    }
    if (listed.length === 0) throw new UserError(`model "${choice.target}": provider "${provider}" lists no models${problem ? ` (${problem})` : ""}; see list_providers`);
    const found = listed.find((entry) => entry.id === model || entry.aliases?.includes(model));
    if (!found) throw new UserError(`model "${choice.target}": "${provider}" has no model "${model}". It has: ${listed.map((entry) => entry.id).join(", ")}`);
    if (choice.thinking && found.thinkingOptions && !found.thinkingOptions.some((option) => option.id === choice.thinking)) {
      throw new UserError(`thinking "${choice.thinking}": ${provider}/${found.id} offers ${found.thinkingOptions.map((option) => option.id).join(", ")}`);
    }
    return { target: `${provider}/${found.id}`, ...(choice.thinking ? { thinking: choice.thinking } : {}) };
  }

  private async stepAgentConfig(run: Run, step: Pick<Step, "id" | "agent">, tools = STEP_TOOL_NAMES, override?: ModelChoice, notes?: string[]) {
    const skipped = engine.activeExhausted(run);
    // The first target not out of tokens (or whose delay has passed) and whose provider's usage is below the threshold; if none is, the primary (it fails over, waits or fails to the manager as before).
    const candidates = await this.stepCandidates(run, step);
    const blocks = override ? new Map<string, UsageBlock>() : await this.usageBlocks(run.playbook, candidates);
    let chosen = candidates.find((candidate) => candidate.model && !skipped.includes(`${candidate.provider}/${candidate.model}`) && !blocks.has(`${candidate.provider}/${candidate.model}`)) ?? candidates[0]!;
    // Only the targets passed over on the way to the chosen one are reported.
    for (const candidate of candidates.slice(0, Math.max(0, candidates.indexOf(chosen)))) {
      const block = blocks.get(`${candidate.provider}/${candidate.model}`);
      if (block) {
        const text = await this.noteUsageSkip(run, step.id, `${candidate.provider}/${candidate.model}`, block);
        notes?.push(text);
      }
    }
    if (override) {
      // The manager's model: the step's mode and thinking carry over only on the same provider.
      const [provider, id] = splitTarget(override.target);
      const base = inheritTarget({ ...candidates[0]!.target, provider: candidates[0]!.provider }, provider, id);
      chosen = { target: override.thinking ? { ...base, thinking: override.thinking } : base, provider, model: id };
    }
    const { target, provider, model } = chosen;
    if (!model) throw new UserError(`step "${step.id}": no model for provider "${provider}"; set agent.model in the playbook`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (target.mode) config.modeId = target.mode;
    if (target.thinking) config.thinkingOptionId = target.thinking;
    return preapprove(config, provider, tools);
  }

  async completeStep(managerId: string, runId: string, stepId: string, input: { outcome: string; summary?: string; outputs?: Record<string, unknown> }): Promise<Run> {
    const run = this.ownedRun(managerId, runId);
    const stepState = run.steps[stepId];
    const autoApplied = run.playbook.steps.find((candidate) => candidate.id === stepId)?.autoComplete;
    if (stepState && autoApplied && stepState.status !== "running" && stepState.status !== "reported" && stepState.attempts.at(-1)?.outcome && autoApplied.includes(stepState.attempts.at(-1)!.outcome!)) {
      throw new UserError(`step "${stepId}" is ${stepState.status}: its outcome "${stepState.attempts.at(-1)!.outcome}" is one the plugin applies itself (role.completion.auto) and it has already been applied; do not call complete_step for it`);
    }
    // A batch step with `settle`: its entries must apply before the step may complete.
    const step = run.batch ? engine.stepDef(run, stepId) : null;
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
    if (run.batch) {
      // Before the batch's last step completes it: no job may leave the pipeline missing an output.
      const batch = structuredClone(run);
      const trial = structuredClone(this.store.get(run.batch.pipelineId) ?? null);
      if (trial) {
        if (pipeline) Object.assign(trial, pipeline);
        const probe: Parameters<typeof engine.completeStep>[2] = { outcome: input.outcome, now: nowIso() };
        if (input.outputs !== undefined) probe.outputs = input.outputs;
        let completes = false;
        try {
          engine.completeStep(batch, stepId, probe);
          completes = batch.status === "completed";
        } catch {
          // The real call below reports why.
        }
        const missing = completes ? engine.jobsMissingOutputs(trial, run) : [];
        if (missing.length > 0) {
          throw new UserError(`"${stepId}" would end the batch with jobs missing outputs they need to leave the pipeline: ${missing.join("; ")}. Set them first (settle_job without an outcome, or the step's settle output) and complete the step again.`);
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
    // A batch's gate is announced to the runs whose jobs it carries; a role decider starts.
    await this.tick();
    return this.store.get(run.id)!.gates.find((gate) => gate.id === result.id) ?? result;
  }

  /** A gate decision from the panel (wakes the manager) or from chat via resume (does not). */
  async decideGate(runId: string, gateId: string, decision: engine.GateDecision): Promise<{ alreadyDecided: boolean; gate: Run["gates"][number] }> {
    const result = await this.store.mutate(runId, (current) => engine.decideGate(current, gateId, decision));
    if (result.gate.kind === "admission") {
      // A pipeline has no manager to tell: the decision acts on the job and the stage's queue.
      if (!result.alreadyDecided) await this.afterAdmissionDecision(runId, result.gate);
      return { alreadyDecided: result.alreadyDecided, gate: result.gate };
    }
    if (!result.alreadyDecided) {
      const manager = this.store.get(runId)?.managerAgentId;
      if (manager) this.gateManagers.add(manager);
    }
    // An ask choice with an outcome may complete a batch step with `settle`.
    if (!result.alreadyDecided) {
      const problems = await this.applySettle(runId, result.gate.stepId);
      if (problems.length > 0) await this.enqueue(runId, problems);
    }
    await this.applyEffects(runId, result.effects);
    await this.admitQueued(runId);
    if (!result.alreadyDecided && decision.via === "panel") {
      const run = this.store.get(runId)!;
      if (run.managerAgentId) await this.dismissQuestions(run.managerAgentId, `The human decided gate ${result.gate.id} in the Playbooks panel instead: ${decision.decision}. Do not call resume. End your turn; you are woken with what comes next.`);
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

  /**
   * archive_run: the panel's archive, for an agent. Idempotent. A run whose hand-off job is still
   * open in a pipeline (waiting or in a batch) is refused unless `force`: archiving hides it
   * while its result is still coming.
   */
  async archiveRunByAgent(runId: string, force: boolean): Promise<{ run: Run; already: boolean }> {
    const existing = this.store.get(runId);
    if (!existing) throw new UserError(`unknown run "${runId}"`);
    if (existing.archivedAt) return { run: existing, already: true };
    if (!force) {
      const open = this.store.list().flatMap((candidate) => candidate.jobs.filter((job) => candidate.id !== runId && job.fromRunId === runId && job.status === "open").map((job) => ({ job, at: candidate })));
      const pipelineJobs = open.filter(({ at }) => !at.batch);
      if (pipelineJobs.length > 0) {
        const where = pipelineJobs.map(({ job, at }) => `${job.id} at ${job.batches.map((r) => `batch ${r.runId}`).concat(job.waiting.map((w) => `stage "${w.stage}"`)).join(", ") || `pipeline ${at.id}`}`).join("; ");
        throw new UserError(`run ${runId} has a job that is not settled yet (${where}): wait for it to settle (settle_job, or the batch ends), or pass force: true to archive anyway`);
      }
    }
    await this.archiveRun(runId);
    return { run: this.store.get(runId)!, already: false };
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
      if (this.store.get(runId)!.managerAgentId) await this.dismissQuestions(this.store.get(runId)!.managerAgentId, `The run was canceled ${by}. End your turn.`);
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
  async nudgeStep(runId: string, stepId: string, message: string, byHuman = false, model?: ModelChoice): Promise<{ agentId: string; target: string } | void> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    if (!byHuman && isPaused(run)) throw new UserError(`run ${run.id} is paused by a human: wait until it is resumed. End your turn.`);
    const state = run.steps[stepId];
    const attempt = state?.attempts.at(-1);
    if (!state || !attempt) throw new UserError(`step "${stepId}" has no attempt to nudge`);
    if (isAgentlessAttempt(attempt.agentId)) throw new UserError(`step "${stepId}" is a ${isScriptAttempt(attempt.agentId) ? "script" : isFanoutAttempt(attempt.agentId) ? "fan-out" : "hand-off"} step: there is no agent to nudge`);
    if (!isStepLive(run, stepId)) throw new UserError(`step "${stepId}" can no longer change: run ${run.id} is ${run.status}`);
    if (model) return this.moveStep(runId, stepId, message, await this.checkModel(model));
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
   * nudge_step with a model: an agent cannot change provider or model, so a new agent on that model
   * takes over the same attempt (no retry used), started with the attempt's prompt and the message.
   * The old agent is archived. Used when the step's provider is out of tokens and no fallback is left.
   */
  private async moveStep(runId: string, stepId: string, message: string, model: ModelChoice): Promise<{ agentId: string; target: string }> {
    const run = this.store.get(runId)!;
    const step = engine.stepDef(run, stepId);
    if (step.kind !== "agent" || !step.role) throw new UserError(`step "${stepId}" is not an agent step: it has no model`);
    const state = run.steps[stepId]!;
    const attempt = state.attempts.at(-1)!;
    if (state.status !== "running" && state.status !== "reported") throw new UserError(`step "${stepId}" is ${state.status}; only a running or reported step can move to another model (start_step takes model too)`);
    if (attempt.report) throw new UserError(`step "${stepId}" attempt ${attempt.n} already reported ${attempt.report.outcome}: call complete_step (or nudge_step without model)`);
    const config = await this.stepAgentConfig(run, step, isManagerless(run) ? MANAGERLESS_STEP_TOOL_NAMES : STEP_TOOL_NAMES, model);
    const role = run.playbook.roles[step.role]!;
    const agent = await this.api()
      .workspaces.ref(run.workspaceId)
      .agents.create({
        config: { ...config, systemPrompt: stepSystemPrompt(run.playbook, step, role, run) },
        ...(run.managerAgentId ? { parent: run.managerAgentId } : {}),
        title: `${run.playbook.title} · ${role.title} #${attempt.n}`,
        labels: { [RUN_LABEL]: run.id, [STEP_LABEL]: stepId, "playbooks/attempt": String(attempt.n) },
      });
    const oldAgent = attempt.agentId;
    this.clearTimeout(oldAgent);
    await this.store.mutate(runId, (current) => engine.moveAttempt(current, stepId, { agentId: agent.id, target: config.provider ?? "", now: nowIso() }));
    const handover = `A previous agent of this attempt (agent ${oldAgent}, on ${attempt.target || "another model"}) stopped before reporting; you take over on ${config.provider}. Check what it already did (git log, git status, the PRs) before redoing work. Its conversation can be read with read_agent_conversation.`;
    const prompt = [attempt.prompt, handover, message.trim() ? `Message from the Playbook Manager:\n${message.trim()}` : ""].filter(Boolean).join("\n\n");
    await agent.send(withPreamble(prompt, this.store.get(runId)!));
    this.armTimeout(this.store.get(runId)!, stepId);
    if (oldAgent !== agent.id) await this.archiveStepAgent(oldAgent);
    return { agentId: agent.id, target: config.provider ?? "" };
  }

  /**
   * Starts a manual after-task, from the panel or, when the human asks in chat, the
   * start_after_task tool (`by` is that agent). The manager is woken to run it, unless it
   * is the caller: it reads the ready steps in the tool result.
   */
  async startAfterTask(runId: string, taskId: string, by: string | null = null): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    if (!isManagerless(run)) {
      const manager = await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
      if (!manager || manager.agent.archivedAt) throw new UserError("this run's Playbook Manager no longer exists");
    }
    const busy = this.workspaceConflict(run.workspaceId, run.playbook.isolation.mode === "worktree", run.id);
    if (busy) throw new UserError(`this workspace has another active run (${busy.id}); wait for it to end`);
    const effects = await this.store.mutate(runId, (current) => engine.startAfterTask(current, taskId, nowIso()));
    if (isManagerless(run)) {
      await this.admitQueued(runId);
      return this.store.get(runId)!;
    }
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
    model?: ModelChoice,
  ): Promise<{ run: Run; newManager: boolean }> {
    const run = this.store.get(runId);
    if (!run) throw new UserError(`unknown run "${runId}"`);
    if (model) {
      const kind = run.playbook.steps.find((step) => step.id === stepId);
      if (kind && (kind.kind !== "agent" || !kind.role)) throw new UserError(`step "${stepId}" is not an agent step: model only applies to an agent step`);
      model = await this.checkModel(model);
    }
    const blocker = restartBlocker(run, stepId);
    if (blocker) throw new UserError(blocker);
    if (isPipeline(run)) throw new UserError(`run ${run.id} is a singleton pipeline: it is not restarted; the next hand-off starts a new one`);
    if (run.batch) throw new UserError(`run ${run.id} is a batch of pipeline ${run.batch.pipelineId}: a failed batch's jobs ride the stage's next batch (or fail, past its retries)`);
    const origin = await this.workspaceOf(run.workspaceId);
    const active = (inWorkspace: string) => this.workspaceConflict(inWorkspace, run.playbook.isolation.mode === "worktree", run.id);
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
    const managerless = isManagerless(run);
    // A run with no manager (manager.mode: none) is restarted by the plugin: no manager is woken, created or taken over.
    if (managerless) takeOver = undefined;
    const manager = managerless || takeOver || move ? null : await this.api().agents.ref(run.managerAgentId).refresh().catch(() => null);
    // A run moved to another workspace always gets a manager there.
    const managerGone = !managerless && !takeOver && (Boolean(move) || !manager || Boolean(manager.agent.archivedAt));
    // The original manager was archived (which also archives its runs): a new one takes over.
    // It is created without a prompt, so it cannot look for the run before the run is its own.
    const replacement = managerGone ? await this.createReplacementManager(homeId, run.playbook) : null;
    // An isolated run gets its worktree back (the ended run's was deleted), with a fresh baseline for the guard.
    const worktree = await this.ensureWorktree(run, move?.dir ?? run.workspaceDir);
    const effects = await this.store.mutate(runId, (current) => {
      const fx = engine.restartRun(current, stepId, { comment, by, now: nowIso(), model: model ?? null });
      if (worktree) current.worktree = worktree;
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
        config: this.managerConfig(playbook, await this.managerSkips(playbook)),
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
    if (run && isManagerless(run)) throw new UserError(`run ${runId} has no Playbook Manager (manager.mode: none): restart the run from the step instead`);
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

  /** A batch step's `settle` output may only name outcomes the singleton has: refused at report time, so the agent corrects it. */
  private checkReportedOutcomes(run: Run, stepId: string, outputs: Record<string, unknown>): void {
    const step = run.batch ? engine.stepDef(run, stepId) : null;
    if (!run.batch || !step?.settle) return;
    const raw = outputs[step.settle.output];
    const pipeline = this.store.get(run.batch.pipelineId);
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
        throw new UserError(`${step.settle.output}: job ${result.jobId} has outcome "${result.outcome}", which is not an outcome of "${pipeline.playbook.id}" (use ${allowed.join(", ")}, or no outcome key for a job that stays in its batch). Fix it and call report_step_result again.`);
      }
    }
  }

  /**
   * What a step changed that it must not have: a readonly role's edits to its checkout, and, in an
   * isolated run, any change to the original workspace checkout (the agent worked in the wrong tree).
   */
  private async checkoutViolation(run: Run, attempt: Attempt): Promise<Violation | null> {
    if (attempt.readonlySnapshot !== null) {
      const detail = snapshotDiff(attempt.readonlySnapshot, await checkoutSnapshot(engine.workDir(run)));
      if (detail) return { kind: "readonly", detail };
    }
    const baseline = run.worktree?.workspaceSnapshot;
    if (baseline) {
      const detail = snapshotDiff(baseline, await checkoutSnapshot(run.workspaceDir));
      if (detail) return { kind: "isolation", detail };
    }
    const wt = run.worktree;
    if (wt && !run.playbook.isolation.allowGitlinkRemoval) {
      const removed = await removedGitlinks(wt.path, wt.baseSha);
      if (removed.length > 0) return { kind: "gitlink", detail: removed.join(", ") };
    }
    return null;
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
    if (isManagerless(run)) {
      const found = await this.checkoutViolation(run, attempt);
      if (found) await this.store.mutate(runId, (current) => engine.markReadonlyViolation(current, stepId, found.detail, nowIso(), found.kind));
      await this.tick();
      return;
    }
    const violation = await this.checkoutViolation(run, attempt);
    if (violation) await this.store.mutate(runId, (current) => engine.markReadonlyViolation(current, stepId, violation.detail, nowIso(), violation.kind));
    if (!violation && (await this.autoCompleteReport(runId, stepId))) return;
    const asked = violation ? null : await this.openReportedAsk(runId, stepId);
    await this.enqueue(runId, [
      `${reportedLine(stepId, attempt.n, this.store.get(runId)!.steps[stepId]!.attempts.at(-1)!.report!)} It reported after its turn had ended.`,
      violation ? violationLine(violation) : "",
      ...(asked ?? [`Call complete_step for "${stepId}".`]),
    ].filter(Boolean));
    await this.deliver(runId);
  }

  /**
   * `role.completion.auto`: a step whose agent reported an outcome the step lists is completed by the plugin, the
   * same way the manager's complete_step would (same validation, same events), and the steps that become ready
   * are started. Only when everything that follows is an agent or script step (engine.autoCompleteBlocker);
   * otherwise it stays reported and the manager is woken as usual. The manager gets a line in its inbox but is not
   * woken for it, unless a ready step could not be started. Returns whether the step was applied.
   */
  private async autoCompleteReport(runId: string, stepId: string): Promise<boolean> {
    const run = this.store.get(runId);
    if (!run || isPaused(run) || !isActive(run) || isPipeline(run)) return false;
    const step = engine.stepDef(run, stepId);
    const attempt = run.steps[stepId]?.attempts.at(-1);
    const report = attempt?.report;
    if (step.kind !== "agent" || !step.autoComplete?.length || !attempt || !report || run.steps[stepId]!.status !== "reported" || !isStepLive(run, stepId)) return false;
    if (!step.autoComplete.includes(report.outcome)) return false;
    const input = { outcome: report.outcome, summary: report.summary, outputs: report.outputs, now: nowIso() };
    let effects: engine.Effects | null;
    try {
      // Checked again inside the mutation: the run may have moved since the snapshot above.
      effects = await this.store.mutate(runId, (current) => {
        const live = current.steps[stepId];
        if (live?.status !== "reported" || live.attempts.at(-1)?.n !== attempt.n || isPaused(current)) return null;
        if (engine.autoCompleteBlocker(current, stepId, input) !== null) return null;
        return engine.completeStep(current, stepId, input);
      });
    } catch (error) {
      console.error(`[playbooks] could not auto-complete step "${stepId}" of ${runId}:`, errorText(error));
      return false;
    }
    if (!effects) return false;
    await this.applyEffects(runId, effects);
    await this.admitQueued(runId);
    const manager = this.store.get(runId)!.managerAgentId;
    const { started, failed } = await this.autoStartReady(manager, runId).catch((error: unknown) => ({ started: [], failed: [{ stepId: "(run)", error: errorText(error) }] }));
    await this.enqueue(runId, [
      reportedLine(stepId, attempt.n, report),
      `The plugin applied it (role.completion.auto): do not call complete_step for "${stepId}".`,
      ...effects.notes,
      started.length > 0 ? `The plugin started: ${started.map((entry) => entry.stepId).join(", ")}.` : "",
      ...failed.map((entry) => `The plugin could not start "${entry.stepId}" (${entry.error}): start it with start_step.`),
    ].filter(Boolean));
    if (failed.length > 0) await this.deliver(runId);
    return true;
  }

  async onStepTurnEnded(runId: string, agentId: string, turnEnd: "completed" | "failed" | "canceled" | "lost" | "timeout", canWait = true): Promise<void> {
    const run = this.store.get(runId);
    if (!run) return;
    const found = engine.findAttemptByAgent(run, agentId);
    if (!found || run.steps[found.stepId]!.status !== "running") return;
    this.clearTimeout(agentId);
    let lastMessage: string | null = null;
    let outOfTokens = false;
    if (!found.attempt.report) {
      const page = await this.api().agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30 }).catch(() => null);
      lastMessage = page ? lastAssistantText(page.entries as never) : null;
      // A failed turn whose error says so, or a turn that ended on the provider's own notice ("You've hit your weekly limit").
      const reason = turnEnd === "failed" && page ? failureText(page.entries as never) : turnEnd === "completed" ? lastMessage : null;
      outOfTokens = turnEnd === "failed" ? isQuotaError(reason) : isQuotaMessage(reason);
      if (outOfTokens && !isPaused(run)) {
        if (await this.failOverStep(runId, found.stepId, agentId, reason ?? "", { canWait })) return;
      }
      if (turnEnd === "completed" && !outOfTokens && !found.attempt.reminded && !isPaused(run) && (await this.remindToReport(runId, found.stepId, agentId))) return;
    }
    const violation = await this.checkoutViolation(run, found.attempt);
    const ended = await this.store.mutate(runId, (current) => {
      const result = engine.endTurn(current, agentId, { turnEnd, lastMessage, now: nowIso() });
      if (result && violation) engine.markReadonlyViolation(current, result.stepId, violation.detail, nowIso(), violation.kind);
      return result;
    });
    if (!ended) return;
    // No manager: the plugin applies the report (or the failure) itself, in its tick.
    if (isManagerless(run)) {
      await this.tick();
      return;
    }
    const report = this.store.get(runId)!.steps[ended.stepId]!.attempts.at(-1)!.report;
    const head = `step "${ended.stepId}" attempt ${ended.attempt.n}`;
    const line = !report && outOfTokens
      ? `${head} ended (${turnEnd}) without reporting: its provider ${ended.attempt.target || "(unknown)"} is out of tokens and no fallback of its role is available.${lastMessage ? ` Last message: ${lastMessage.slice(0, 500)}` : ""} Move it to another model: nudge_step with model (a provider/model from list_providers and list_models; the same attempt, no retry used), or wait for the reset and nudge_step it without model. To avoid this, set providers.fallback in defaults/main.yaml.`
      : report
      ? `${reportedLine(ended.stepId, ended.attempt.n, report)}${turnEnd === "timeout" ? " If its work is in fact done, nudge_step it to report: its report replaces the timeout failure. Or call complete_step with the outputs from its conversation." : ""}`
      : ended.attempt.reminded
        ? `${head} ended (${turnEnd}) without reporting, even after the plugin asked it to.${lastMessage ? ` Last message: ${lastMessage.slice(0, 1500)}` : ""} If it is still waiting on something, nudge_step it later. If it could not report (e.g. report_step_result "not found"), check the outputs it gave in its conversation and call complete_step with them.`
        : `${head} ended (${turnEnd}) without reporting.${lastMessage ? ` Last message: ${lastMessage.slice(0, 1500)}` : ""} Use nudge_step to ask it to report, or complete_step.`;
    if (report && !violation && turnEnd === "completed" && (await this.autoCompleteReport(runId, ended.stepId))) return;
    const asked = report && !violation ? await this.openReportedAsk(runId, ended.stepId) : null;
    const others = Object.entries(this.store.get(runId)!.steps)
      .filter(([, state]) => state.status === "running")
      .map(([id]) => id);
    await this.enqueue(runId, [
      line,
      violation ? violationLine(violation) : "",
      ...(asked ?? [`Call complete_step for "${ended.stepId}".`]),
      others.length > 0 ? `Still running: ${others.join(", ")}.` : "",
    ].filter(Boolean));
    await this.deliver(runId);
  }

  /**
   * A step agent's turn failed because its provider is out of tokens: the same attempt restarts
   * on the next target of its chain, with the same prompt and without using a retry. False if no
   * target is left or the new agent could not start (the failure then goes to the manager).
   */
  private async failOverStep(runId: string, stepId: string, agentId: string, reason: string, options: { canWait?: boolean; resuming?: boolean } = {}): Promise<boolean> {
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || !attempt || attempt.agentId !== agentId || !attempt.target || isAgentlessAttempt(agentId)) return false;
    const step = engine.stepDef(run, stepId);
    if (step.kind !== "agent" || !step.role) return false;
    const exhausted = attempt.target;
    const probe = structuredClone(run);
    if (!options.resuming) engine.markTarget(probe, exhausted, nowIso());
    let config: AgentConfig;
    const skips: string[] = [];
    try {
      config = await this.stepAgentConfig(probe, step, STEP_TOOL_NAMES, undefined, skips);
    } catch {
      config = { provider: exhausted };
    }
    // Every target of the chain is out: marked exhausted by a failure, or at the usage threshold.
    let chain: string[] = [];
    let blocks = new Map<string, UsageBlock>();
    try {
      const candidates = await this.stepCandidates(probe, step);
      chain = candidates.map((candidate) => `${candidate.provider}/${candidate.model}`);
      blocks = await this.usageBlocks(probe.playbook, candidates);
    } catch {
      // The chain stays unknown: the check below falls back to the exhausted marks alone.
    }
    const marked = engine.activeExhausted(probe);
    if (marked.includes(config.provider ?? exhausted) || (chain.length > 0 && chain.every((target) => marked.includes(target) || blocks.has(target)))) {
      if (run.playbook.onExhausted === "wait" && options.canWait !== false) {
        // A target is back at its provider's reset time when usage names one, else at the end of its `exhausted_for`.
        const backs = chain
          .map((target) => {
            const reset = blocks.get(target)?.resetsAt;
            return reset ? Date.parse(reset) : engine.exhaustedUntil(probe, [target]);
          })
          .filter((time): time is number => time !== null && Number.isFinite(time));
        const resetAt = backs.length > 0 ? Math.min(...backs) : null;
        const first = !attempt.waiting;
        const waiting = await this.store.mutate(runId, (current) => {
          if (!options.resuming) engine.markTarget(current, exhausted, nowIso());
          return engine.startWaiting(current, stepId, { target: exhausted, reason, now: nowIso(), resetAt });
        });
        if (waiting) {
          this.armWait(this.store.get(runId)!, stepId);
          const until = this.store.get(runId)!.steps[stepId]!.attempts.at(-1)!.waiting!.until;
          if (first) {
            await this.enqueue(runId, [`step "${stepId}" attempt ${attempt.n}: every provider of its role is out of tokens; the plugin waits and restarts the attempt with the same brief at ${new Date(until).toLocaleString()} (no retry used)${run.playbook.maxWaitMs ? `, giving up after ${humanDuration(run.playbook.maxWaitMs)} in all` : ""}. Nothing to do: do not nudge or complete it; you are woken when it reports or fails.`]);
            await this.deliver(runId);
          }
          return true;
        }
      }
      await this.store.mutate(runId, (current) => {
        engine.markExhausted(current, stepId, exhausted, nowIso(), reason);
        const last = engine.currentAttempt(current, stepId);
        if (last) last.waiting = null;
      });
      return false;
    }
    const role = run.playbook.roles[step.role]!;
    let agent;
    try {
      agent = await this.api()
        .workspaces.ref(run.workspaceId)
        .agents.create({
          config: { ...config, systemPrompt: stepSystemPrompt(run.playbook, step, role, probe) },
          parent: run.managerAgentId,
          title: `${run.playbook.title} · ${role.title} #${attempt.n}`,
          labels: { [RUN_LABEL]: run.id, [STEP_LABEL]: stepId, "playbooks/attempt": String(attempt.n) },
        });
    } catch (error) {
      console.error(`[playbooks] could not restart step "${stepId}" of ${runId} on ${config.provider}:`, errorText(error));
      await this.store.mutate(runId, (current) => engine.markExhausted(current, stepId, exhausted, nowIso(), reason));
      return false;
    }
    this.clearTimeout(agentId);
    await this.store.mutate(runId, (current) =>
      engine.failOverAttempt(current, stepId, { target: exhausted, agentId: agent.id, newTarget: config.provider ?? "", now: nowIso(), reason, resumed: options.resuming === true }),
    );
    await agent.send(withPreamble(attempt.prompt, this.store.get(runId)!)).catch((error: unknown) => console.error(`[playbooks] could not brief ${agent.id}:`, errorText(error)));
    this.armTimeout(this.store.get(runId)!, stepId);
    await this.archiveStepAgent(agentId);
    if (options.resuming) {
      await this.enqueue(runId, [`step "${stepId}" attempt ${attempt.n}: waited for tokens; the plugin restarted the attempt on ${config.provider} with the same brief (no retry used). Nothing to do: it will report as usual.`]);
      await this.deliver(runId);
      return true;
    }
    await this.enqueue(runId, [`step "${stepId}" attempt ${attempt.n}: ${exhausted} is out of tokens; the plugin restarted the attempt on ${config.provider} with the same brief (no retry used); ${exhausted} is tried again after ${humanDuration(run.playbook.exhaustedForMs)}.${skips.length > 0 ? ` Skipped by provider usage: ${skips.join("; ")}.` : ""} Nothing to do: it will report as usual.`]);
    await this.deliver(runId);
    return true;
  }

  /** Schedules the restart of an attempt that waits for tokens (`attempt.waiting.until`). */
  private armWait(run: Run, stepId: string): void {
    const attempt = run.steps[stepId]?.attempts.at(-1);
    if (!attempt?.waiting) return;
    this.clearTimeout(attempt.agentId);
    const due = Date.parse(attempt.waiting.until) - Date.now();
    const timer = setTimeout(() => void this.onWaitEnded(run.id, stepId, attempt.agentId), Math.max(0, due));
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(attempt.agentId, timer);
  }

  /** The wait is over: restart the attempt on the first provider that is back, wait again if none is, or fail once `max_wait` is spent. */
  private async onWaitEnded(runId: string, stepId: string, agentId: string): Promise<void> {
    this.timers.delete(agentId);
    const run = this.store.get(runId);
    const attempt = run?.steps[stepId]?.attempts.at(-1);
    if (!run || attempt?.agentId !== agentId || !attempt.waiting || run.steps[stepId]!.status !== "running") return;
    // A paused run starts nothing: look again in a minute.
    if (isPaused(run)) {
      const timer = setTimeout(() => void this.onWaitEnded(runId, stepId, agentId), 60_000);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.timers.set(agentId, timer);
      return;
    }
    if (await this.failOverStep(runId, stepId, agentId, "tokens still out", { resuming: true })) return;
    // No wait left (max_wait spent, or the new agent could not start): the failure goes to the manager.
    await this.store.mutate(runId, (current) => {
      const last = engine.currentAttempt(current, stepId);
      if (last?.agentId === agentId) last.waiting = null;
    });
    await this.onStepTurnEnded(runId, agentId, "failed", false);
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

  /** An agent the plugin set up: a manager, or a step or decider agent of a run. */
  private isRunAgent(agentId: string): boolean {
    return this.runsOfManager(agentId).length > 0 || this.stepRunOf(agentId) !== null || this.deciderOf(agentId) !== null;
  }

  /**
   * After a plugin reload: reloads the idle agents whose session holds the old plugin's tools
   * (those still running are reloaded when their turn ends). Off with `reload_stale_sessions: false`.
   */
  private async reloadStaleSessions(): Promise<void> {
    const listed = await this.api().agents.list({});
    for (const { agent } of listed.entries) {
      if (agent.archivedAt || agent.status !== "idle") continue;
      await this.sessions.reloadIfStale(this.api(), agent.id, { known: agent.labels?.[STEP_LABEL] !== undefined || agent.labels?.[GATE_LABEL] !== undefined || this.isRunAgent(agent.id) });
    }
  }

  /** Lifecycle hook: any agent's turn ended. */
  async onTurnEnded(agentId: string, outcome: "completed" | "failed" | "canceled", parentAgentId: string | null = null): Promise<void> {
    // First, while the agent is idle: what follows may send it a new turn.
    await this.sessions.reloadIfStale(this.api(), agentId, { known: this.isRunAgent(agentId) });
    await this.recordUsage(agentId);
    if (await this.onSidekickTurnEnded(agentId, parentAgentId, outcome).catch((error) => (console.error("[playbooks] Sidekick turn handling failed:", errorText(error)), false))) return;
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
    await this.askGatesInChat().catch((error) => console.error("[playbooks] gate question failed:", errorText(error)));
    await this.cleanupEndedWorktrees().catch((error) => console.error("[playbooks] worktree cleanup failed:", errorText(error)));
    await this.archiveEndedWorkspaces().catch((error) => console.error("[playbooks] workspace archive check failed:", errorText(error)));
  }

  /** Where the tokens went (see shared/analytics.ts), over the runs on disk. */
  async analytics(options: { days?: number | undefined; playbook?: string | undefined; projectId?: string | undefined; limit?: number | undefined } = {}): Promise<Analytics> {
    const since = options.days ? new Date(Date.now() - options.days * 86_400_000).toISOString() : null;
    return analyze(this.store.list(), { since, playbook: options.playbook ?? null, projectId: options.projectId ?? null, agents: await this.usageLedger.list(), ...(options.limit ? { limit: options.limit } : {}) });
  }

  /**
   * Records what the agent spent since its last turn: `lastUsage` is cumulative for the session, so the
   * ledger turns it into a delta, which goes to the step attempt, gate decider or manager run it belongs
   * to. Every agent that ends a turn goes in the ledger, also those outside the runs.
   */
  private async recordUsage(agentId: string): Promise<void> {
    try {
      const run = this.deciderOf(agentId)?.run ?? this.stepRunOf(agentId)?.run ?? this.activeRunOfManager(agentId) ?? this.runsOfManager(agentId)[0];
      const agent = (await this.api().agents.ref(agentId).refresh())?.agent;
      const reading = agent?.lastUsage;
      if (!agent || !reading) return;
      const decider = this.deciderOf(agentId);
      const found = run ? engine.findAttemptByAgent(run, agentId) : null;
      const stepRole = found ? run!.playbook.steps.find((step) => step.id === found.stepId)?.role ?? null : null;
      const kind = decider ? "decider" : found ? "step" : run?.managerAgentId === agentId ? "manager" : agent.labels?.[SIDEKICK_LABEL] !== undefined ? "sidekick" : "other";
      const delta = await this.usageLedger.record(
        agentId,
        { title: agent.title ?? "", kind, role: decider ? decider.gate.decider.role ?? null : stepRole, model: [agent.provider, agent.model].filter(Boolean).join("/") || null, runId: run?.id ?? null },
        reading,
      );
      if (!run) return;
      await this.store.mutate(run.id, (current) => {
        const gate = current.gates.find((candidate) => candidate.deciderAgentId === agentId);
        if (gate) {
          gate.usage = addUsage(gate.usage, delta);
          return;
        }
        const attemptOf = engine.findAttemptByAgent(current, agentId);
        if (attemptOf) {
          const attempt = current.steps[attemptOf.stepId]!.attempts.at(-1)!;
          attempt.usage = addUsage(attempt.usage, delta);
          return;
        }
        if (current.managerAgentId === agentId) current.managerUsage = addUsage(current.managerUsage, delta);
      });
    } catch (error) {
      console.error(`[playbooks] could not record usage of ${agentId}:`, errorText(error));
    }
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
      const wt = this.store.get(run.id)?.worktree;
      if (wt && wt.state !== "removed") await this.dropWorktree(run.id, wt, await this.repoOf(run, wt), true).catch((error: unknown) => console.error(`[playbooks] could not remove the worktree of ${run.id}:`, errorText(error)));
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
    // An attempt waiting for tokens has no timeout or silence check: its new agent gets them whole.
    if (attempt.waiting) return;
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
    // No manager (manager.mode: none): no stall handling beyond the step's own `timeout`; the silence reminder is a nudge.
    if (!attempt || isManagerless(run) || isAgentlessAttempt(attempt.agentId) || attempt.silenceReminded || run.steps[stepId]!.status !== "running") return;
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
    if (!run || isManagerless(run) || attempt?.agentId !== agentId || attempt.silenceReminded || run.steps[stepId]!.status !== "running") return;
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
    if (isFanoutAttempt(agentId)) {
      await this.cancelFanoutChildren(runId, agentId, "its fan-out step timed out");
      await this.finishFanout(runId, stepId, agentId, { outcome: "failure", summary: `timed out after ${Math.round(timeoutMs / 60000)} min waiting for its runs`, outputs: {} });
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
  /** The manager's targets (its tier, primary first) with their resolved provider and model. */
  private managerTargets(playbook: Playbook) {
    const targets: AgentSettings[] = [playbook.manager, ...(playbook.manager.fallback ?? [])];
    return targets.map((target) => {
      const provider = target.provider ?? DEFAULT_PROVIDER;
      return { target, provider, model: target.model ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined) };
    });
  }

  /** `exhausted` plus the manager targets whose provider's usage is at the threshold: what a new manager skips. */
  private async managerSkips(playbook: Playbook, exhausted: string[] = []): Promise<string[]> {
    const blocks = await this.usageBlocks(playbook, this.managerTargets(playbook));
    return [...exhausted, ...blocks.keys()];
  }

  private managerConfig(playbook: Playbook, exhausted: string[] = []): AgentConfig {
    // A multi-entry tier: the first target not out of tokens (nor at the usage threshold) at creation (the manager never switches mid-run).
    const resolved = this.managerTargets(playbook);
    const { target, provider, model } = resolved.find((candidate) => candidate.model && !exhausted.includes(`${candidate.provider}/${candidate.model}`)) ?? resolved[0]!;
    if (!model) throw new UserError(`no model for the manager on provider "${provider}"; set manager.model in defaults/main.yaml`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (target.mode) config.modeId = target.mode;
    if (target.thinking) config.thinkingOptionId = target.thinking;
    preapprove(config, provider, MANAGER_TOOL_NAMES);
    return config;
  }

  /**
   * start_playbook called with `workspaceId`, or by a Sidekick: the run starts in that existing workspace (a new Playbook
   * Manager there) or, with `newWorkspace`, in a new workspace branched off it. The caller is not the manager. A Sidekick
   * must name a workspace of its own project, and never its own hidden one.
   */
  async isSidekick(agentId: string): Promise<boolean> {
    return (await this.sidekickRegistry.findByAgent(agentId)) !== null;
  }

  async startPlaybookInWorkspace(caller: { id: string; workspaceId: string | null }, input: { playbook: string; inputs: Record<string, VarValue>; workspaceId: string | undefined; newWorkspace: boolean; autoStart?: boolean; workspaceName?: string | undefined }) {
    const isSidekick = await this.isSidekick(caller.id);
    if (input.workspaceName && !input.newWorkspace) throw new UserError("workspaceName names the new workspace: pass it with newWorkspace");
    // Without workspaceId a Sidekick branches the new workspace off its own (hidden) one, which is the project's root checkout.
    const baseId = input.workspaceId ?? (isSidekick && input.newWorkspace ? caller.workspaceId : !isSidekick ? caller.workspaceId : null);
    if (!baseId) throw new UserError("workspaceId is missing: name a workspace of this project (list_workspaces) to branch the new workspace off");
    if (!input.newWorkspace && isSidekick && (!input.workspaceId || input.workspaceId === caller.workspaceId)) throw new UserError("a Sidekick never runs in its own hidden workspace: pass workspaceId of an existing workspace, or start the run in a new one");
    if (!input.newWorkspace && !(await this.isIsolatedPlaybook(baseId, input.playbook))) throw new UserError(`"${input.playbook}" has no \`isolation: { mode: worktree }\`: it starts in a new workspace, never in an existing one`);
    const workspace = await this.api().workspaces.ref(baseId).refresh();
    if (!workspace) throw new UserError(isSidekick && !input.workspaceId ? "the Sidekick's own workspace is gone, so there is no project root to branch the new workspace off: pass workspaceId (list_workspaces)" : `workspace "${baseId}" not found (list_workspaces lists them)`);
    const callerProject = await this.projectIdOf(caller.workspaceId);
    if (callerProject && workspace.projectId !== callerProject) throw new UserError("that workspace belongs to another project");
    const started = await this.startFromPanel({ workspaceId: workspace.id, playbook: input.playbook, inputs: input.inputs, force: false, sameWorkspace: !input.newWorkspace, autoStart: input.autoStart !== false, workspaceName: input.workspaceName });
    if (started.status === "duplicate") throw new UserError(`${started.message} Not started again.`);
    return started;
  }

  async startFromPanel(input: {
    workspaceId: string;
    playbook: string;
    inputs: Record<string, VarValue>;
    force: boolean;
    agentId?: string | undefined;
    sameWorkspace?: boolean | undefined;
    /** false: the new manager creates the run and leaves its ready steps unstarted (default true). */
    autoStart?: boolean | undefined;
    /** Title of the new workspace (only when one is created); empty: the default title. */
    workspaceName?: string | undefined;
    /** A fan-out step starting a child run: its id (reserved before the workspace exists) and its parent link. */
    child?: { runId: string; parent: NonNullable<Run["parent"]> } | undefined;
  }) {
    if (input.workspaceName?.trim() && (input.agentId || input.sameWorkspace)) throw new UserError("workspaceName names a new workspace: it does not apply when the run starts in this one");
    const workspace = await this.api().workspaces.ref(input.workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    const workspaceDir = workspace.workspaceDirectory ?? workspace.projectRootPath;
    const loaded = await loadPlaybooks(workspaceDir, { projectId: workspace.projectId });
    const entry = lookup(loaded.entries, input.playbook);
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
    if (input.agentId && playbook.managerMode === "none") throw new UserError(`"${playbook.id}" has no Playbook Manager (manager.mode: none): no agent manages it; start it without choosing one`);
    if (input.agentId) return this.startWithAgent(workspace.id, input.agentId, playbook, resolved.inputs);
    if (input.sameWorkspace && playbook.managerMode === "none") {
      const busy = this.workspaceConflict(workspace.id, playbook.isolation.mode === "worktree");
      if (busy) throw new UserError(`this workspace already has an active run (${busy.id}); use "Start in a new workspace"${playbook.isolation.mode === "worktree" ? "" : ", or give the playbook `isolation: worktree` so runs can share a workspace"}`);
      const run = await this.startPlaybook({ id: "", workspaceId: workspace.id, cwd: workspaceDir }, playbook.id, resolved.inputs, { playbook });
      return { status: "started" as const, workspaceId: workspace.id, managerAgentId: "", runId: run.id, queued: false };
    }
    if (input.sameWorkspace) {
      const busy = this.workspaceConflict(workspace.id, playbook.isolation.mode === "worktree");
      if (busy) throw new UserError(`this workspace already has an active run (${busy.id}); use "Start in a new workspace"${playbook.isolation.mode === "worktree" ? "" : ", or give the playbook `isolation: worktree` so runs can share a workspace"}`);
      // The new agent creates the run itself with start_playbook, which takes this reserved id.
      const runId = `run_${shortId()}`;
      this.addReservation(workspace.id, { runId, branch: null, playbook, inputs: resolved.inputs });
      const manager = await this.api().workspaces.ref(workspace.id).agents.create({
        config: this.managerConfig(playbook, await this.managerSkips(playbook)),
        title: `Playbook Manager · ${playbook.title}`,
        labels: { [MANAGER_LABEL]: "true" },
        prompt: managerKickoff(playbook, resolved.inputs, input.autoStart !== false),
      });
      return { status: "started" as const, workspaceId: workspace.id, managerAgentId: manager.id, runId, queued: false };
    }
    return this.startInNewWorkspace(workspaceDir, playbook, resolved.inputs, input.workspaceName, input.child);
  }


  /**
   * The Sidekick of a project: one coordinator agent in a hidden background workspace whose directory is the
   * project root, defined by the project's `sidekick/` files. Created on first use and again if it was
   * archived; the plugin subscribes it to the events it watches, for this project's runs. Concurrent calls
   * for a project share one creation.
   */
  openSidekick(workspaceId: string): Promise<{ projectId: string; workspaceId: string; agentId: string; created: boolean }> {
    return this.withProject(workspaceId, async (project) => {
      const pending = this.sidekickOpening.get(project.projectId);
      if (pending) return pending;
      const creation = this.ensureSidekick(project).finally(() => this.sidekickOpening.delete(project.projectId));
      this.sidekickOpening.set(project.projectId, creation);
      return creation;
    });
  }

  /**
   * The human's "restart session": replaces the project's Sidekick by a new agent that starts from the
   * last hand-off it saved (none: a blank start). The old agent is archived, even mid-turn. Shares the
   * opening lock, so it never races an open.
   */
  restartSidekick(workspaceId: string): Promise<{ projectId: string; workspaceId: string; agentId: string; created: boolean }> {
    return this.withProject(workspaceId, async (project) => {
      const pending = this.sidekickOpening.get(project.projectId);
      if (pending) await pending.catch(() => undefined);
      const restart = (async () => {
        const known = await this.sidekickRegistry.read(project.projectId);
        if (!known) return this.ensureSidekick(project);
        const load = await loadSidekick(project.root);
        if (!load.configured) throw new UserError(`this project has no Sidekick: add a sidekick/ folder to its playbooks folder (see "Create the Sidekick files")`);
        if (!load.config) throw new UserError(`the Sidekick files have errors:\n${load.errors.join("\n")}`);
        this.sidekickRolling.delete(known.agentId);
        this.sidekickAsked.delete(known.agentId);
        this.sidekickHeld.delete(known.agentId);
        await this.api().agents.ref(known.agentId).archive().catch(() => undefined);
        return this.launchSidekick(project, load, known, known.handoff);
      })().finally(() => this.sidekickOpening.delete(project.projectId));
      this.sidekickOpening.set(project.projectId, restart);
      return restart;
    });
  }

  /** The workspace's project: id, label and root directory. */
  private async projectOf(workspaceId: string) {
    const workspace = await this.api().workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    return {
      projectId: workspace.projectId,
      label: workspace.projectDisplayName || path.basename(workspace.projectRootPath),
      root: workspace.projectRootPath,
    };
  }

  private async withProject<T>(workspaceId: string, fn: (project: { projectId: string; label: string; root: string }) => Promise<T>): Promise<T> {
    return fn(await this.projectOf(workspaceId));
  }

  /** The project of a workspace (null when it is unknown): for callers that load the playbooks a project has turned profiles on for. */
  async projectIdOf(workspaceId: string | null | undefined): Promise<string | null> {
    if (!workspaceId) return null;
    return (await this.projectOf(workspaceId).catch(() => null))?.projectId ?? null;
  }

  /** The project root of a workspace, for callers that act on the project's files. */
  async projectRootOf(workspaceId: string): Promise<string> {
    return (await this.projectOf(workspaceId)).root;
  }

  /** For each project (given by one of its workspaces): its Sidekick config, agent and active runs. */
  async sidekickProjects(workspaces: Array<{ projectId: string; workspaceId: string }>) {
    const registry = await this.sidekickRegistry.all();
    const projects = [];
    for (const { projectId, workspaceId } of workspaces) {
      const project = await this.projectOf(workspaceId).catch(() => null);
      if (!project) continue;
      const load = await loadSidekick(project.root);
      const record = registry[projectId];
      const agent = record ? await this.api().agents.ref(record.agentId).refresh().catch(() => null) : null;
      const open = this.store.list().filter((run) => run.projectId === projectId && !run.archivedAt);
      projects.push({
        projectId,
        workspaceId,
        label: project.label,
        configured: load.configured,
        errors: load.errors,
        agentId: agent && !agent.agent.archivedAt ? record!.agentId : null,
        activeRuns: open.filter((run) => !isTerminal(run.status)).length,
        needYou: open.reduce((count, run) => count + run.gates.filter(waitsForHuman).length, 0),
      });
    }
    return projects;
  }

  private async ensureSidekick(project: { projectId: string; label: string; root: string }) {
    const load = await loadSidekick(project.root);
    if (!load.configured) throw new UserError(`this project has no Sidekick: add a sidekick/ folder to its playbooks folder (see "Create the Sidekick files")`);
    if (!load.config) throw new UserError(`the Sidekick files have errors:\n${load.errors.join("\n")}`);
    const known = await this.sidekickRegistry.read(project.projectId);
    if (known) {
      const agent = await this.api().agents.ref(known.agentId).refresh().catch(() => null);
      if (agent && !agent.agent.archivedAt) return { projectId: project.projectId, ...known, created: false };
    }
    return this.launchSidekick(project, load, known, known?.handoff);
  }

  /** Creates the Sidekick agent (in its hidden workspace, made if it is gone), saves it, and subscribes it to its events. */
  private async launchSidekick(project: { projectId: string; label: string; root: string }, load: Awaited<ReturnType<typeof loadSidekick>>, known: { workspaceId: string } | null, handoff: string | undefined) {
    const settings = load.config!;
    const provider = settings.provider ?? DEFAULT_PROVIDER;
    const model = settings.model ?? (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
    if (!model) throw new UserError(`no model for the Sidekick on provider "${provider}"; set sidekick.model in sidekick/sidekick.yaml`);
    const config: AgentConfig = { provider: `${provider}/${model}` };
    if (settings.mode) config.modeId = settings.mode;
    if (settings.thinking) config.thinkingOptionId = settings.thinking;
    preapprove(config, provider, SIDEKICK_PLUGIN_TOOLS);
    if (config.options) {
      config.options.allowedTools.push(...SIDEKICK_PASEO_TOOLS.map((tool) => `mcp__paseo__${tool}`));
    }
    // Reuse the hidden workspace while it is alive; otherwise make a new one on the project root.
    let workspaceId = known?.workspaceId ?? null;
    if (workspaceId && !(await this.api().workspaces.ref(workspaceId).refresh().catch(() => null))) workspaceId = null;
    const workspace = workspaceId
      ? this.api().workspaces.ref(workspaceId)
      : await this.api().workspaces.create({ title: sidekickTitle(project.label), source: { kind: "directory", path: project.root }, background: true });
    for (const warning of load.warnings) console.warn(`[playbooks] ${warning}`);
    const subagent = { ...DEFAULT_SIDEKICK_SUBAGENT, ...(settings.mode ? { mode: settings.mode } : {}), ...settings.subagents };
    const agent = await workspace.agents.create({
      config,
      title: sidekickTitle(project.label),
      labels: { [SIDEKICK_LABEL]: "true", [SIDEKICK_PROJECT_LABEL]: project.projectId },
      prompt: `${sidekickPrompt({ projectId: project.projectId, label: project.label, root: project.root, watch: settings.watch, subagent, ...(settings.runs ? { runs: settings.runs } : {}) }, load.instructions)}\n\n${sidekickKickoff(handoff)}`,
    });
    const record = { workspaceId: workspaceId ?? workspace.id, agentId: agent.id };
    await this.sidekickRegistry.write(project.projectId, record);
    await this.subscribeEvents(agent.id, settings.watch, { projectId: project.projectId }, "idle").catch((error) =>
      console.error("[playbooks] could not subscribe the Sidekick:", errorText(error)),
    );
    return { projectId: project.projectId, ...record, created: true };
  }

  /** `sidekick_handoff`: saves the Sidekick's ledger; with `restart`, it is replaced by a new session when its turn ends. */
  async sidekickHandoff(agentId: string, summary: string, restart: boolean): Promise<string> {
    const found = await this.sidekickRegistry.findByAgent(agentId);
    if (!found) throw new UserError("only a Sidekick can hand off");
    await this.sidekickRegistry.write(found.projectId, { ...found.record, handoff: summary });
    if (!restart) return "Saved. The next session of the Sidekick starts from it.";
    this.sidekickRolling.add(agentId);
    return "Saved. End your turn now: the plugin starts a new session that continues from it.";
  }

  /** Replaces a Sidekick by a new agent that starts from its saved hand-off; the old one is archived (its subscriptions end with it). */
  private async rollSidekick(projectId: string, record: { workspaceId: string; agentId: string; handoff?: string | undefined }): Promise<void> {
    this.sidekickRolling.delete(record.agentId);
    this.sidekickAsked.delete(record.agentId);
    this.sidekickSwept.delete(record.agentId);
    const project = { ...(await this.projectOf(record.workspaceId)), projectId };
    const load = await loadSidekick(project.root);
    if (!load.config) return;
    await this.api().agents.ref(record.agentId).archive();
    await this.launchSidekick(project, load, record, record.handoff);
  }

  /**
   * A Sidekick's own turn ended, or a subagent of one did. Subagents' finish notices wait until the
   * Sidekick is idle (so they never cut into a question to the human); a Sidekick past its context
   * threshold is asked to hand off, then restarted.
   */
  private async onSidekickTurnEnded(agentId: string, parentAgentId: string | null, outcome: string): Promise<boolean> {
    if (parentAgentId) {
      const parent = await this.sidekickRegistry.findByAgent(parentAgentId);
      if (!parent) return false;
      const notice = `[playbooks] Subagent ${agentId.slice(0, 8)} finished its turn (${outcome}); read its report with get_agent_activity (limit 1).`;
      const sidekick = await this.api().agents.ref(parentAgentId).refresh().catch(() => null);
      if (sidekick?.agent.status === "idle") await this.api().agents.ref(parentAgentId).send(notice);
      else this.sidekickHeld.set(parentAgentId, [...(this.sidekickHeld.get(parentAgentId) ?? []), notice]);
      return true;
    }
    const own = await this.sidekickRegistry.findByAgent(agentId);
    if (!own) return false;
    // Its turn is over: not busy any more (an end-of-turn send below starts a new one), and held event notices can go out.
    this.busyManagers.delete(agentId);
    if (this.sidekickRolling.has(agentId)) {
      await this.rollSidekick(own.projectId, own.record);
      await this.bus.flush();
      return true;
    }
    const project = await this.projectOf(own.record.workspaceId).catch(() => null);
    const limit = (project ? (await loadSidekick(project.root)).config?.restartAboveTokens : undefined) ?? DEFAULT_SIDEKICK_RESTART_TOKENS;
    const used = (await this.api().agents.ref(agentId).refresh().catch(() => null))?.agent.lastUsage?.contextWindowUsedTokens ?? 0;
    const parts = this.sidekickHeld.get(agentId) ?? [];
    this.sidekickHeld.delete(agentId);
    if (used > limit) {
      // Asked once; if it still has not handed off after its next turn, restart it from the last saved ledger.
      if (this.sidekickAsked.has(agentId)) {
        await this.rollSidekick(own.projectId, own.record);
        await this.bus.flush();
        return true;
      }
      this.sidekickAsked.add(agentId);
      parts.push(sidekickHandoffRequest(used));
    }
    // End-of-turn sweep: open gates waiting for a human that this Sidekick was not yet told about.
    const swept = this.sidekickSwept.get(agentId) ?? new Set<string>();
    this.sidekickSwept.set(agentId, swept);
    const open = this.store.list().filter((run) => run.projectId === own.projectId && !run.archivedAt).flatMap((run) => run.gates.filter(waitsForHuman).map((gate) => ({ runId: run.id, gate })));
    const fresh = open.filter(({ runId, gate }) => !swept.has(`${runId}:${gate.id}`));
    for (const key of [...swept]) if (!open.some(({ runId, gate }) => `${runId}:${gate.id}` === key)) swept.delete(key);
    if (fresh.length > 0) {
      for (const { runId, gate } of fresh) swept.add(`${runId}:${gate.id}`);
      parts.push(sidekickGateSweep(fresh.map(({ runId, gate }) => ({ runId, gateId: gate.id, stepId: gate.stepId }))));
    }
    if (parts.length > 0) {
      this.busyManagers.add(agentId);
      try {
        await this.api().agents.ref(agentId).send(parts.join("\n\n"));
      } catch (error) {
        this.busyManagers.delete(agentId);
        throw error;
      }
    } else await this.bus.flush();
    return true;
  }

  /** A new workspace branched off this one's current ref, with a new Playbook Manager that starts the run there. */
  private async startInNewWorkspace(workspaceDir: string, playbook: Playbook, inputs: Record<string, VarValue>, workspaceName?: string, child?: { runId: string; parent: NonNullable<Run["parent"]> }) {
    const runId = child?.runId ?? `run_${shortId()}`;
    const id = runId.replace(/^run_/, "");
    const branch = worktreeBranch(playbook.id, id);
    const base = (await currentRef(workspaceDir)) ?? undefined;
    const created = await this.api().workspaces.create({
      title: workspaceTitle(playbook.title, inputs, workspaceName),
      source: { kind: "worktree", cwd: workspaceDir, action: "branch-off", branchName: branch, ...(base ? { refName: base } : {}) },
    });
    this.addReservation(created.id, { runId, branch, playbook, inputs, created: true, ...(child ? { parent: child.parent } : {}) });
    if (playbook.managerMode === "none") {
      // No manager agent: the plugin creates the run itself, from the reservation, and drives it.
      try {
        const run = await this.startPlaybook({ id: "", workspaceId: created.id, cwd: workspaceDir }, playbook.id, inputs, { playbook });
        return { status: "started" as const, workspaceId: created.id, managerAgentId: "", runId: run.id };
      } catch (error) {
        this.reservations.delete(created.id);
        throw error;
      }
    }
    const manager = await created.agents.create({
      config: this.managerConfig(playbook, await this.managerSkips(playbook)),
      title: `Playbook Manager · ${playbook.title}`,
      labels: { [MANAGER_LABEL]: "true" },
      prompt: managerKickoff(playbook, inputs),
    });
    return { status: "started" as const, workspaceId: created.id, managerAgentId: manager.id, runId };
  }

  /**
   * start_playbook with `newWorkspace`: the run gets its own workspace and its own Playbook
   * Manager, so any manager can start one, a batch's included (rework for an ejected job).
   */
  async startPlaybookElsewhere(manager: { cwd: string; workspaceId: string | null }, playbookId: string, inputs: Record<string, unknown>, workspaceName?: string) {
    let workspaceDir = manager.cwd;
    let projectId: string | null = null;
    if (manager.workspaceId) {
      const workspace = await this.api().workspaces.ref(manager.workspaceId).refresh();
      if (workspace) {
        workspaceDir = workspace.workspaceDirectory ?? manager.cwd;
        projectId = workspace.projectId;
      }
    }
    const loaded = await loadPlaybooks(workspaceDir, projectId ? { projectId } : {});
    const found = findEntry(loaded.entries, playbookId);
    if ("error" in found) throw new UserError(found.error);
    const entry = found.entry;
    if (!entry) throw new UserError(`no playbook "${playbookId}" in this workspace (have: ${loaded.entries.map((e) => e.id).join(", ") || "none"})`);
    if (!entry.playbook) throw new UserError(`playbook "${playbookId}" is invalid:\n${entry.errors.join("\n")}`);
    const playbook = entry.playbook;
    if (playbook.singleton) throw new UserError(`"${playbookId}" is a singleton: it runs in its own pipeline workspace; start it without newWorkspace`);
    const resolved = engine.resolveRunInputs(playbook, inputs);
    if (!resolved.ok) throw new UserError(resolved.errors.join("; "));
    if (projectId) this.checkConcurrency(playbook, projectId);
    return this.startInNewWorkspace(workspaceDir, playbook, resolved.inputs, workspaceName);
  }

  /** Whether the playbook, as the workspace has it, declares `isolation: { mode: worktree }` (false when the workspace or playbook is missing or invalid). */
  async isIsolatedPlaybook(workspaceId: string, playbookId: string): Promise<boolean> {
    const workspace = await this.api().workspaces.ref(workspaceId).refresh();
    if (!workspace) return false;
    const loaded = await loadPlaybooks(workspace.workspaceDirectory ?? workspace.projectRootPath, { projectId: workspace.projectId });
    return lookup(loaded.entries, playbookId)?.playbook?.isolation.mode === "worktree";
  }

  /** Whether the workspace holds a reservation for exactly this playbook and inputs: what the Playbook Manager the plugin created for it calls start_playbook with (another agent of the workspace starting its own run is not that). */
  hasReservationFor(workspaceId: string | null, playbookId: string, inputs: Record<string, unknown>): boolean {
    if (workspaceId === null) return false;
    return (this.reservations.get(workspaceId) ?? []).some((r) => {
      if (r.playbook.id !== playbookId) return false;
      const resolved = engine.resolveRunInputs(r.playbook, inputs);
      return resolved.ok && JSON.stringify(resolved.inputs) === JSON.stringify(r.inputs);
    });
  }

  hasReservation(workspaceId: string | null): boolean {
    return workspaceId !== null && (this.reservations.get(workspaceId)?.length ?? 0) > 0;
  }
}
