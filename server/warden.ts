import { isActive, isTerminal, runningAfterTasks, type Run, WardenAction, WardenCheck, WardenFinding } from "../shared/types";
import { slowDetail, type SlowInfo } from "../shared/slow";
import { isDeferred } from "../shared/gates";
import { gateListing, gateHolder } from "./overseer";
import { openAge, type ClosedHours } from "./closed-hours";

/**
 * The warden's rules (ADR 2026-11-18-warden). Detection only: no I/O of its own (the runtime passes in what needs the
 * daemon or git), no LLM, no message to an agent. The runtime applies them once per event scan; nothing runs while
 * `warden.enabled` is false.
 */

/** How often the warden looks at what is due (each run follows its own `interval`). */
export const WARDEN_CHECK_MS = 30_000;
/** Runs looked at in one pass: the rest wait for the next (the longest-waiting first). */
export const WARDEN_MAX_RUNS_PER_PASS = 25;

export type Act = Exclude<WardenAction, "none">;

/** A condition a check found: its identity is `check` + `subject`; `signature` changing makes it a new finding. */
export interface Candidate {
  check: WardenCheck;
  subject: string | null;
  signature: string;
  detail: string;
  action: Act;
  /** A count or measure (loop count, idle minutes): reported again only once it has doubled since the last report. */
  value?: number;
  /** The run's state: reported again when it differs from the last report's. */
  state?: string;
  /** PR checks only: the owning run, the PR and the action proposed (as text). */
  runId?: string | null;
  pr?: { number: number; url: string } | null;
  proposed?: string | null;
}

/** What the runtime reads for the checks that need the daemon or git. */
export interface WardenIo {
  /** The commit origin/<base> is at now (fetched); null when the run is not isolated or origin cannot be read. */
  originSha(run: Run): Promise<string | null>;
  /** The run's manager: `running`, `idle`, or `gone` (archived, closed, errored, not found); null when it has none. */
  manager(run: Run): Promise<"running" | "idle" | "gone" | null>;
  /** Whether the run's manager is stopped on its provider's out-of-tokens notice (read only for a stalled run). */
  managerQuota(run: Run): Promise<boolean>;
  /** Why and until when the manager cannot work (read only for a stalled run whose manager is quota-blocked). */
  managerUnblock(run: Run): Promise<ManagerUnblock>;
}

/** The providers a quota-blocked manager waits on, and the earliest time one of its targets may be tried again (epoch ms; null when unknown). */
export interface ManagerUnblock {
  providers: string[];
  until: number | null;
}

/**
 * The exhausted providers among the manager's `targets` (an active `exhausted` mark, or a usage window at the threshold) and the
 * earliest unblock time: the end of the earliest mark (`exhausted_for`) or the earliest reset of a blocking window, whichever
 * applies. A target with a mark and a window counts its earlier end only when both are known (the mark is the plugin's proof, the
 * window the provider's own reading): the earliest of the two is the first moment a retry can succeed.
 */
export function managerUnblock(run: Run, targets: Array<{ provider: string; model?: string | undefined }>, blocks: Map<string, { resetsAt: string | null }>, nowMs: number): ManagerUnblock {
  const providers = new Set<string>();
  const ends: number[] = [];
  for (const { provider, model } of targets) {
    const key = `${provider}/${model}`;
    const mark = run.exhausted.find((entry) => entry.target === key);
    const markEnd = mark ? Date.parse(mark.at) + run.playbook.exhaustedForMs : NaN;
    const block = blocks.get(key);
    const reset = block?.resetsAt ? Date.parse(block.resetsAt) : NaN;
    const markActive = Number.isFinite(markEnd) && markEnd > nowMs;
    if (!markActive && !block) continue;
    providers.add(provider);
    for (const end of [markActive ? markEnd : NaN, reset]) if (Number.isFinite(end)) ends.push(end);
  }
  return { providers: [...providers].sort(), until: ends.length > 0 ? Math.min(...ends) : null };
}

/** The unblock time as a finding states it, and its hour bucket (a change of one hour or more is material and re-reports). */
const unblockText = (unblock: ManagerUnblock): string => `unblocks at ${unblock.until === null ? "unknown" : new Date(unblock.until).toISOString()}; exhausted: ${unblock.providers.length > 0 ? unblock.providers.join(", ") : "unknown"}`;
const unblockBucket = (unblock: ManagerUnblock): string => (unblock.until === null ? "unknown" : String(Math.floor(unblock.until / 3_600_000)));

export const findingKey = (check: WardenCheck, subject: string | null): string => `${check}:${subject ?? ""}`;

/**
 * Milliseconds the run spent held for quota (ADR 2026-11-23-warden-held-check): each `run_held` up to its `run_released`
 * (or now while the hold lasts), summed from the history. A hold is an expected, self-resolving state, so time-based checks
 * subtract it instead of counting it as the run being slow, old or idle.
 */
export function heldMs(run: Run, now: number): number {
  let total = 0;
  let since: number | null = null;
  for (const entry of run.history) {
    if (entry.type === "run_held" && since === null) since = Date.parse(entry.at);
    else if (entry.type === "run_released" && since !== null) {
      total += Math.max(0, Date.parse(entry.at) - since);
      since = null;
    }
  }
  if (since === null && run.rateHold) since = Date.parse(run.rateHold.since);
  return since !== null && Number.isFinite(since) ? total + Math.max(0, now - since) : total;
}

/** The step runs slower than their baseline, as the slow-step warning computes them (only steps still running). */
export function slowCandidates(run: Run, slow: Record<string, SlowInfo>, action: Act, now = Date.now(), closed?: ClosedHours | null): Candidate[] {
  return Object.entries(slow)
    .filter(([id]) => run.steps[id]?.status === "running")
    .flatMap(([id, shown]) => {
      // Closed hours pause the clock: the step's elapsed time counts its open time only, and it is slow only if that still passes the factor.
      const started = Date.parse(run.steps[id]?.attempts[0]?.startedAt ?? "");
      const elapsedMs = closed && Number.isFinite(started) ? Math.min(shown.elapsedMs, openAge(closed, started, now)) : shown.elapsedMs;
      const info = { ...shown, elapsedMs, ratio: elapsedMs / shown.baselineMs };
      if (elapsedMs !== shown.elapsedMs && info.ratio <= run.playbook.slowWarning.factor) return [];
      return [{ check: "slow" as const, subject: id, signature: `${id}@${run.steps[id]?.attempts[0]?.startedAt ?? ""}`, detail: `step ${id} has run ${slowDetail(info)}`, action }];
    });
}

/** Gates open for `afterMs` or more (the same age as gate.stale: gateListing's). */
export function gateOpenCandidates(run: Run, afterMs: number, now: number, action: Act, closed?: ClosedHours | null): Candidate[] {
  return run.gates
    .filter((gate) => gate.status === "pending" && !isDeferred(gate))
    .flatMap((gate) => {
      const opened = Date.parse(gate.requestedAt);
      const age = closed && Number.isFinite(opened) ? Math.floor(openAge(closed, opened, now) / 60_000) : gateListing(run, gate, now).ageMinutes;
      return age !== null && age * 60_000 >= afterMs ? [{ check: "gate_open" as const, subject: gate.id, signature: gate.id, detail: `gate ${gate.id} (${gate.kind}) of step ${gate.stepId} has been open ${age} min, held by ${gateHolder(gate).heldBy}`, action }] : [];
    });
}

/** Goto edges that fired more than `above` times. */
export function loopCandidates(run: Run, above: number, action: Act): Candidate[] {
  return Object.entries(run.loops)
    .filter(([, count]) => count > above)
    .map(([edge, count]) => ({ check: "loops" as const, subject: edge, signature: edge, detail: `edge ${edge} fired ${count} times (limit ${above})`, action, value: count }));
}

/**
 * A run pinned to a definition other than origin's current one: read from the workspace checkout, or at an older commit that
 * the run has held for `afterMs` or more (the definition is pinned when the run starts, so its age is the run's). A healthy
 * run on a recent pin is not reported. Not looked at: whether origin changed a file this run's steps use (ADR 2026-11-20-warden-stale-definition-age).
 */
export function staleDefinitionCandidate(run: Run, originSha: string | null, afterMs: number, now: number, action: Act, closed?: ClosedHours | null): Candidate[] {
  const definition = run.definition;
  if (!definition || !originSha) return [];
  if (onlyWaitingOnGate(run)) return [];
  const aged = openAge(closed, Date.parse(run.createdAt), now) - heldMs(run, now) >= afterMs;
  const stale = definition.source === "workspace" || (aged && definition.sha !== null && definition.sha !== originSha);
  if (!stale) return [];
  const pinned = definition.source === "workspace" ? "the workspace checkout" : `${definition.ref ?? "origin"}@${(definition.sha ?? "").slice(0, 8)}`;
  return [{ check: "stale_definition", subject: null, signature: `${definition.source}@${originSha}`, detail: `the definition is pinned to ${pinned}, origin is at ${originSha.slice(0, 8)}`, action, state: `${run.status}${run.pausedAt ? "+paused" : ""}` }];
}

/** Whether anything of the run is running, ready or queued (or waiting on a sub-run), or an after-task runs. */
const hasWork = (run: Run): boolean => Object.values(run.steps).some((step) => ["running", "ready", "queued", "waiting"].includes(step.status)) || runningAfterTasks(run).length > 0;
const hasOpenGate = (run: Run): boolean => run.gates.some((gate) => gate.status === "pending");

/** A run that is only waiting on a gate (open gate, nothing running, ready or queued): the gate is what holds it, not a stale definition. */
export function onlyWaitingOnGate(run: Run): boolean {
  return hasOpenGate(run) && !hasWork(run);
}

/** What a stalled run last did and since when: its last event that is not the warden's own note. */
export interface StalledInfo {
  /** Epoch ms of the run's last event (its creation when it has none). */
  idleSince: number;
  last: string;
  steps: string;
}

/**
 * The run is active (not finished, not paused, not a pipeline or batch), has no running, ready or queued step (nor one
 * waiting on a sub-run, nor a running after-task) and no open gate: nothing will move it by itself. Null otherwise.
 */
export function stalledInfo(run: Run): StalledInfo | null {
  if (!isActive(run) || isTerminal(run.status) || run.pausedAt || run.playbook.singleton || run.batch) return null;
  if (hasWork(run) || hasOpenGate(run)) return null;
  // A held run is waiting for quota by design (the plugin resumes it): never stalled, and the idle clock restarts at the release (an event).
  if (run.rateHold) return null;
  const event = [...run.history].reverse().find((entry) => entry.type !== "warden");
  const at = Date.parse(event?.at ?? run.createdAt);
  const counts = new Map<string, string[]>();
  for (const [id, step] of Object.entries(run.steps)) if (step.status !== "pending" && step.status !== "skipped") counts.set(step.status, [...(counts.get(step.status) ?? []), id]);
  const steps = [...counts].map(([status, ids]) => `${status}: ${ids.join(", ")}`).join("; ");
  const last = event ? `${event.type}${event.stepId ? ` on ${event.stepId}` : ""}${event.detail ? ` (${event.detail.slice(0, 120)})` : ""} at ${event.at}` : "nothing yet";
  return { idleSince: at, last, steps: steps || "none started" };
}

/** The run has been stalled for `afterMs` or more. `manager`: its state, and whether it is stopped on a quota notice. */
export function stalledCandidates(run: Run, info: StalledInfo | null, afterMs: number, now: number, manager: "running" | "idle" | "gone" | null, quotaBlocked: boolean, action: Act, closed?: ClosedHours | null, unblock: ManagerUnblock | null = null): Candidate[] {
  const idle = info ? openAge(closed, info.idleSince, now) : 0;
  if (!info || idle < afterMs) return [];
  const minutes = Math.round(idle / 60_000);
  const managerText = manager === null ? "no manager" : quotaBlocked ? `the manager is quota-blocked (${unblock ? unblockText(unblock) : "unblock time unknown"})` : `the manager is ${manager}`;
  const since = new Date(info.idleSince).toISOString();
  return [{ check: "stalled", subject: null, signature: quotaBlocked && unblock ? `${since}|${unblockBucket(unblock)}` : since, detail: `no running, ready or queued step and no open gate for ${minutes} min; ${managerText}; last: ${info.last}; steps ${info.steps}`, action, value: minutes, state: `${manager ?? "none"}${quotaBlocked ? "+quota" : ""}` }];
}

/**
 * An active run held for quota (not paused by a human) for `afterMs` or more. The finding gives the reason, the provider and
 * usage window, the run's place and priority in the queue, who is ahead of it (the other held runs of the same provider and
 * window with a lower position), the estimated cost against the headroom and the retry time.
 */
export function heldCandidates(run: Run, runs: Run[], afterMs: number, now: number, action: Act, closed?: ClosedHours | null): Candidate[] {
  const hold = run.rateHold;
  if (!hold || !isActive(run) || isTerminal(run.status) || run.pausedAt) return [];
  const since = Date.parse(hold.since);
  if (!Number.isFinite(since) || openAge(closed, since, now) < afterMs) return [];
  const minutes = Math.round(openAge(closed, since, now) / 60_000);
  const ahead = hold.position === null ? [] : runs.filter((other) => other.id !== run.id && other.rateHold && !other.archivedAt && isActive(other) && other.rateHold.provider === hold.provider && other.rateHold.window === hold.window && other.rateHold.position !== null && other.rateHold.position < (hold.position as number)).sort((a, b) => a.rateHold!.position! - b.rateHold!.position!);
  const where = hold.provider ? `${hold.provider}${hold.window ? ` ${hold.window}` : ""}` : "no provider";
  const queue = hold.position === null ? "no queue position" : `position ${hold.position}${hold.priority === null ? "" : `, priority ${hold.priority}`}`;
  const front = ahead.length > 0 ? `ahead: ${ahead.map((other) => `${other.id} (${other.playbook.id})`).join(", ")}` : hold.position === null ? "ahead: unknown" : "no other held run ahead";
  const cost = hold.estimatedCost === null && hold.headroom === null ? "" : `; estimated cost ${hold.estimatedCost ?? "?"} vs headroom ${hold.headroom ?? "?"}`;
  return [{ check: "held", subject: null, signature: hold.since, detail: `held ${minutes} min for quota (${hold.kind}: ${hold.reason}); ${where}; ${queue}; ${front}${cost}; ${hold.retryAt ? `retry at ${hold.retryAt}` : "no retry time (waits for room)"}`, action, value: minutes, state: hold.kind }];
}

/** Open gates only the manager can decide, while the manager is idle; any open gate while it is gone. */
export function managerBlockedCandidates(run: Run, manager: "running" | "idle" | "gone" | null, action: Act): Candidate[] {
  if (manager === null || manager === "running") return [];
  return run.gates
    .filter((gate) => gate.status === "pending")
    .filter((gate) => manager === "gone" || (gateHolder(gate).by === "manager" && gate.escalated === null))
    .map((gate) => ({ check: "manager_blocked" as const, subject: gate.id, signature: `${gate.id}:${manager}`, detail: `${manager === "gone" ? "the manager is gone" : "the manager is idle"} while gate ${gate.id} (${gate.kind}) of step ${gate.stepId} is open`, action }));
}

/** What the pass changes: the findings to keep, and the ones to report now (new, changed, or still true after the cooldown). */
export function diffFindings(
  existing: Record<string, WardenFinding>,
  candidates: Candidate[],
  nowIso: string,
  cooldownMs: number,
): { next: Record<string, WardenFinding>; report: Array<{ finding: WardenFinding; fresh: boolean; candidate: Candidate }> } {
  const next: Record<string, WardenFinding> = {};
  const report: Array<{ finding: WardenFinding; fresh: boolean; candidate: Candidate }> = [];
  const now = Date.parse(nowIso);
  for (const candidate of candidates) {
    const key = findingKey(candidate.check, candidate.subject);
    if (next[key]) continue;
    const old = existing[key];
    const changed = !old || old.signature !== candidate.signature;
    // Still true: reported again only after the cooldown AND when it grew (value doubled) or the run's state changed (ADR 2026-11-23-warden-stalled-and-repeat-suppression). A finding measuring neither repeats every cooldown.
    const tracked = candidate.value !== undefined || candidate.state !== undefined;
    const grew = candidate.value !== undefined && old?.value != null && candidate.value >= old.value * 2;
    const moved = candidate.state !== undefined && old?.state != null && candidate.state !== old.state;
    const due = changed || (now - Date.parse(old.reportedAt) >= cooldownMs && (!tracked || grew || moved));
    // The baseline moves only when reported (or when first measured: a finding stored before these fields existed).
    const value = due ? (candidate.value ?? null) : (old?.value ?? candidate.value ?? null);
    const state = due ? (candidate.state ?? null) : (old?.state ?? candidate.state ?? null);
    const finding: WardenFinding = { check: candidate.check, subject: candidate.subject, signature: candidate.signature, detail: candidate.detail, since: changed ? nowIso : old.since, reportedAt: due ? nowIso : old.reportedAt, acted: changed ? null : old.acted, runId: candidate.runId ?? null, pr: candidate.pr ?? null, proposed: candidate.proposed ?? null, value, state };
    next[key] = finding;
    if (due) report.push({ finding, fresh: changed, candidate });
  }
  return { next, report };
}

/** The one message a Sidekick gets per pass: only what is new or changed, per run. */
export function wardenSummary(items: Array<{ runId: string; playbook: string; runName: string | null; findings: WardenFinding[] }>): string {
  const lines = items.flatMap((item) => item.findings.map((finding) => `- ${item.runId} (${item.playbook}${item.runName ? `, ${item.runName}` : ""}) ${finding.check}: ${finding.detail}`));
  return `[playbooks] The warden found ${lines.length} thing${lines.length === 1 ? "" : "s"} that may need action:\n${lines.join("\n")}\nRead each with get_run (its \`warden\` field) before acting; the warden will not repeat a finding until its cooldown passes and it has grown (a count doubled) or the run changed state, or it changes.`;
}

/** The one message a Sidekick gets per PR pass: each finding with its run (when any), PR, cause and proposed action. */
export function wardenPrSummary(findings: WardenFinding[]): string {
  const lines = findings.map((finding) => `- ${finding.runId ? `run ${finding.runId}` : "no run"}, ${finding.check}: ${finding.detail}. Proposed: ${finding.proposed ?? "look at it"}.`);
  return `[playbooks] The warden found ${lines.length} thing${lines.length === 1 ? "" : "s"} that may need action on open pull requests:\n${lines.join("\n")}\nThe warden only proposes: check the PR and the run (get_run) before acting, and put to the human what needs them. It will not repeat a finding until its cooldown passes or it changes.`;
}
