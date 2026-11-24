import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "../shared/types";
import type { RateLimitsConfig } from "./config";
import { MIN_SLOW_SAMPLE_MS } from "../shared/slow";
import { byQueue, roomFreeAt, roomHeadroom, runPriority, type HoldVerdict, type Probe, type WindowRoom } from "./rate-limit";

/**
 * Dynamic capacity (ADR 2026-11-20-dynamic-rate-limits): the work that may start is what the quota headroom covers. Headroom of a
 * usage window = what is allowed so far minus current usage minus what started work still has to use; work starts while the headroom
 * covers its estimated cost. This file holds the cost history and the admission plan; the runtime applies them. All amounts are
 * quota points (percent of a usage window).
 */

/** The unit the headroom of a window is kept in: provider and window id. */
export const windowKey = (provider: string, windowId: string): string => `${provider}\u0000${windowId}`;

interface Sample {
  points: number;
  steps: number;
  /**
   * Agent time that produced `timedPoints` of the points (ADR 2026-11-24-quota-per-hour): the summed overlap of the finished agent
   * attempts with the usage readings their points were measured from. Absent in a history written before it existed.
   */
  ms?: number;
  /** The part of `points` measured together with `ms`. After an upgrade it is smaller than `points` until the old average decays. */
  timedPoints?: number;
}

/** A learned per-step mean duration of finished agent attempts, per playbook and step id. */
interface StepTime {
  ms: number;
  n: number;
}

/** The key of the per-step durations in the history file: it cannot be a playbook id, and an older reader skips it (no finite `points`). */
const STEP_TIMES_KEY = "@stepTimes";
/** When the learned data of a playbook, or of one of its steps, was last reset by hand (ADR 2026-11-24-burn-rate-naming-and-reset): `<playbook>` or `<playbook>|<step>` to an ISO time. */
const RESETS_KEY = "@resets";
/** Cap of the weight of old samples, as for the points. */
const KEEP_SAMPLES = 200;
/** The burn rate is used for pacing only once this much agent time backs it: below it, the per-step unit cost applies. */
export const MIN_RATE_MS = 60_000;
/** An attempt shorter than this teaches no duration (it did not really run), as in the slow-step baseline (shared/slow.ts). */
export const MIN_STEP_TIME_MS = MIN_SLOW_SAMPLE_MS;

/** What one remaining agent step of a run is, for the remaining need. */
export interface StepNeed {
  stepId: string;
  /** How long its running attempt has run so far; 0 when none runs. */
  elapsedMs: number;
  running: boolean;
}

/** The remaining need of a run on a window: points, and the steps counted by duration (their use must not be deducted again). */
export interface RemainingNeed {
  points: number;
  byDuration: Set<string>;
  /** Every step is priced by duration x rate: the figure is "about `ms` of agent time at the burn rate". */
  allByDuration: boolean;
  /** The summed expected remaining duration of the steps priced by duration. */
  ms: number;
}

/** What a reset erased (ADR 2026-11-24-burn-rate-naming-and-reset): cost rows (playbook only), finished attempts they rested on, agent time. */
export interface Erased {
  entries: number;
  steps: number;
  ms: number;
}

/** One playbook|provider|window row of the learned history, as analytics shows it. */
export interface RateRow {
  playbook: string;
  provider: string;
  window: string;
  /** Finished agent attempts the average rests on. */
  steps: number;
  pointsPerStep: number;
  /** Agent time the rate rests on (ms); null for a history without it. */
  agentMs: number | null;
  /** Points per active agent hour; null while there is no agent time yet. */
  pointsPerHour: number | null;
}

/**
 * What agent steps cost in quota, per playbook, provider and window: points used / steps finished, and the agent time that produced
 * them, measured from the usage readings (the runtime attributes each reading's increase to the steps running in the interval).
 * Also the mean duration of the finished agent attempts per playbook step. Kept in a file so it survives a reload.
 */
export class CostHistory {
  private data = new Map<string, Sample>();
  private times = new Map<string, StepTime>();
  private resets = new Map<string, string>();

  constructor(private readonly file: string | null = null) {
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (key === RESETS_KEY) {
            for (const [resetKey, at] of Object.entries((value ?? {}) as Record<string, unknown>)) if (typeof at === "string") this.resets.set(resetKey, at);
            continue;
          }
          if (key === STEP_TIMES_KEY) {
            for (const [stepKey, time] of Object.entries((value ?? {}) as Record<string, StepTime>)) if (time && Number.isFinite(time.ms) && time.n > 0) this.times.set(stepKey, { ms: time.ms, n: time.n });
            continue;
          }
          const sample = value as Sample | null;
          if (!sample || !Number.isFinite(sample.points) || !(sample.steps > 0)) continue;
          const timed = Number.isFinite(sample.ms) && Number.isFinite(sample.timedPoints) && (sample.ms ?? 0) >= 0;
          this.data.set(key, { points: sample.points, steps: sample.steps, ...(timed ? { ms: sample.ms!, timedPoints: sample.timedPoints! } : {}) });
        }
      } catch {
        // A damaged history only means estimates start from the default again.
      }
    }
  }

  private key = (playbookId: string, provider: string, windowId: string) => `${playbookId}|${windowKey(provider, windowId)}`;

  /** Average points one step of the playbook used on the window, or null with no history. */
  stepCost(playbookId: string, provider: string, windowId: string): number | null {
    const sample = this.data.get(this.key(playbookId, provider, windowId));
    return sample && sample.steps > 0 ? sample.points / sample.steps : null;
  }

  /** Points per millisecond of active agent time on the window, or null while less than MIN_RATE_MS of agent time backs it (or none was measured). */
  burnRate(playbookId: string, provider: string, windowId: string): number | null {
    const sample = this.data.get(this.key(playbookId, provider, windowId));
    return sample && sample.ms !== undefined && sample.timedPoints !== undefined && sample.ms >= MIN_RATE_MS ? sample.timedPoints / sample.ms : null;
  }

  /** Mean duration (ms) of a finished agent attempt of the step, or null with no sample. */
  stepDuration(playbookId: string, stepId: string): number | null {
    const time = this.times.get(`${playbookId}|${stepId}`);
    return time && time.n > 0 ? time.ms / time.n : null;
  }

  /**
   * What the remaining agent steps of a run still need on a window. Each step is counted once, from one source: its expected
   * remaining duration (mean duration minus the time its running attempt has run, never below 0) times the burn rate, when both are
   * known; else the unit cost per step. Null with no cost history on the window.
   */
  remainingNeed(playbookId: string, provider: string, windowId: string, steps: StepNeed[]): RemainingNeed | null {
    const unit = this.stepCost(playbookId, provider, windowId);
    if (unit === null) return null;
    const rate = this.burnRate(playbookId, provider, windowId);
    const byDuration = new Set<string>();
    let points = 0;
    let ms = 0;
    for (const step of steps) {
      const duration = rate === null ? null : this.stepDuration(playbookId, step.stepId);
      if (rate !== null && duration !== null) {
        const left = Math.max(0, duration - (step.running ? step.elapsedMs : 0));
        points += left * rate;
        ms += left;
        byDuration.add(step.stepId);
      } else points += unit;
    }
    return { points, byDuration, allByDuration: steps.length > 0 && byDuration.size === steps.length, ms };
  }

  /** The window ids the playbook has a measured cost for on the provider. */
  windows(playbookId: string, provider: string): string[] {
    const prefix = `${playbookId}|${provider}\u0000`;
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  /** How many finished steps the average of this playbook on the provider rests on (the smallest over its windows seen). */
  samples(playbookId: string, provider: string): number {
    let count = 0;
    for (const [key, sample] of this.data) if (key.startsWith(`${playbookId}|${provider}\u0000`)) count = count === 0 ? sample.steps : Math.min(count, sample.steps);
    return count;
  }

  /** Every learned row, for analytics. */
  rows(): RateRow[] {
    const rows: RateRow[] = [];
    for (const [key, sample] of this.data) {
      const [playbook, rest] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const [provider, window] = rest.split("\u0000");
      const timed = sample.ms !== undefined && sample.timedPoints !== undefined && sample.ms > 0;
      rows.push({ playbook, provider: provider ?? "", window: window ?? "", steps: sample.steps, pointsPerStep: sample.points / sample.steps, agentMs: sample.ms ?? null, pointsPerHour: timed ? (sample.timedPoints! / sample.ms!) * 3_600_000 : null });
    }
    return rows;
  }

  /**
   * Records one finished step: its points per window, and the agent time those points were measured over (per window; a window
   * without time adds points only, as an old history did).
   */
  add(playbookId: string, provider: string, points: Record<string, number>, ms: Record<string, number> = {}): void {
    for (const [windowId, value] of Object.entries(points)) {
      const key = this.key(playbookId, provider, windowId);
      const sample = this.data.get(key) ?? { points: 0, steps: 0 };
      // Old steps weigh less: after 200 samples each new one replaces a 200th of the average.
      const keep = sample.steps >= KEEP_SAMPLES ? sample.steps - 1 : sample.steps;
      const scale = keep / Math.max(sample.steps, 1);
      const next: Sample = { points: sample.points * scale + value, steps: keep + 1 };
      const time = ms[windowId];
      if (sample.ms !== undefined || time !== undefined) {
        next.ms = (sample.ms ?? 0) * scale + (time ?? 0);
        next.timedPoints = (sample.timedPoints ?? 0) * scale + (time !== undefined ? value : 0);
      }
      this.data.set(key, next);
    }
  }

  /** Records the duration of a finished agent attempt of a playbook step. */
  addStepTime(playbookId: string, stepId: string, ms: number): void {
    if (!(ms >= MIN_STEP_TIME_MS)) return;
    const key = `${playbookId}|${stepId}`;
    const time = this.times.get(key) ?? { ms: 0, n: 0 };
    const keep = time.n >= KEEP_SAMPLES ? time.n - 1 : time.n;
    this.times.set(key, { ms: (time.ms * keep) / Math.max(time.n, 1) + ms, n: keep + 1 });
  }

  /**
   * Hard reset (ADR 2026-11-24-burn-rate-naming-and-reset). Playbook (`step` null): erases every learned cost row of the playbook
   * (all providers and windows: points, steps, agent time) and every step duration. Step: erases that step's learned duration only;
   * the points are learned per playbook, not per step, so they stay (the step is then priced by the per-step cost until measured again).
   * Records the time of the reset. Idempotent: a second call erases nothing.
   */
  reset(playbookId: string, step: string | null, at: string): Erased {
    const erased: Erased = { entries: 0, steps: 0, ms: 0 };
    if (step === null) {
      for (const [key, sample] of [...this.data]) {
        if (!key.startsWith(`${playbookId}|`)) continue;
        erased.entries += 1;
        erased.steps += sample.steps;
        erased.ms += sample.ms ?? 0;
        this.data.delete(key);
      }
      for (const key of [...this.times.keys()]) if (key.startsWith(`${playbookId}|`)) this.times.delete(key);
      this.resets.set(playbookId, at);
      return erased;
    }
    const time = this.times.get(`${playbookId}|${step}`);
    if (time) {
      erased.steps = time.n;
      erased.ms = time.ms;
      this.times.delete(`${playbookId}|${step}`);
    }
    this.resets.set(`${playbookId}|${step}`, at);
    return erased;
  }

  /** Every playbook that has a learned cost row or a step duration (what a reset of all burn rates erases), sorted. */
  playbookIds(): string[] {
    const ids = new Set<string>();
    for (const key of [...this.data.keys(), ...this.times.keys()]) ids.add(key.slice(0, key.indexOf("|")));
    return [...ids].filter(Boolean).sort();
  }

  /** When the playbook (or its step) was last reset by hand; null when never. */
  resetAt(playbookId: string, step: string | null = null): string | null {
    return this.resets.get(step === null ? playbookId : `${playbookId}|${step}`) ?? null;
  }

  async save(): Promise<void> {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body: Record<string, unknown> = Object.fromEntries(this.data);
    if (this.times.size > 0) body[STEP_TIMES_KEY] = Object.fromEntries(this.times);
    if (this.resets.size > 0) body[RESETS_KEY] = Object.fromEntries(this.resets);
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, this.file);
  }
}

/** Run work that waits for headroom: how many agent steps it wants to start on each provider. */
export interface Candidate {
  run: Run;
  priority: number;
  /** provider → number of steps (all the run's remaining agent steps). */
  demand: Map<string, number>;
  /** A run released while waiting at a gate that was decided or returned: ahead of runs that never started, at the same priority (ADR 2026-11-24-deferred-releases-now-returning-first). */
  returning?: boolean;
}

export interface PlanContext {
  now: number;
  config: RateLimitsConfig;
  /** The provider's usage rooms, seen through the limits of `run` (its own `usable_percent`); without a run, the user-level limits. */
  probe: (provider: string, run?: Run) => Probe;
  /** Points one step of the run's playbook is expected to use on the window: its measured history; null while there is none (not paced by estimate). */
  stepCost: (run: Run, provider: string, windowId: string) => number | null;
  /**
   * The remaining need of the run for a provider window: its remaining agent steps by expected duration x burn rate where known, else
   * the unit cost (ADR 2026-11-24-quota-per-hour). Optional: without it, `stepCost` x the step count.
   */
  runCost?: (run: Run, provider: string, windowId: string) => number | null;
  /** Points started work still has to use on the window (reservations not yet visible in the readings). */
  reserved: (provider: string, windowId: string) => number;
}

export interface Plan {
  /** The held candidates, with why. A candidate not in the map may start. */
  holds: Map<string, HoldVerdict>;
  /** Providers a candidate uses that report no usage: not paced. */
  unreported: Set<string>;
  /** The candidates that may start, with the points each takes per window key: what to reserve. */
  admitted: Map<string, Record<string, number>>;
}

/**
 * An estimated need at or below this many points (a window percent) counts as zero: such work cannot move the pace, so it is never
 * held for headroom, never paused to fit the pace, takes nothing and is not blocked behind a held waiter. 0.05 is a twentieth of a
 * point: below what one usage reading can resolve and below what the panel shows (one decimal).
 */
export const ZERO_COST_POINTS = 0.05;

const pts = (value: number) => `${Math.round(value * 10) / 10}`;

/** The estimated cost of a candidate on one window: its remaining need (duration x rate per step where known, else steps × per-step cost), never above what the window can ever hold. */
export function candidateCost(candidate: Candidate, room: WindowRoom, ctx: PlanContext, count: number): { cost: number; estimated: boolean } {
  const whole = ctx.runCost?.(candidate.run, room.provider, room.id) ?? null;
  if (whole !== null) return { cost: Math.min(whole, room.usable), estimated: true };
  const unit = ctx.stepCost(candidate.run, room.provider, room.id);
  return unit !== null ? { cost: Math.min(count * unit, room.usable), estimated: true } : { cost: 0, estimated: false };
}

/**
 * Decides which waiting candidates may start now. Candidates are taken by priority, then oldest first; each one that fits takes
 * its cost from the headroom of every window of its providers, so the next sees what is left. One that does not fit is held, and
 * blocks lower candidates of the same provider (they never jump the queue, so a large run is not starved by small ones). The
 * tightest window wins. A provider with no usage report is not paced and is listed in `unreported`.
 */
export function planHeadroom(candidates: Candidate[], ctx: PlanContext): Plan {
  const holds = new Map<string, HoldVerdict>();
  const unreported = new Set<string>();
  const admitted = new Map<string, Record<string, number>>();
  // Points taken so far per window; the headroom itself is read through each candidate's own limits (its usable percent).
  const taken = new Map<string, number>();
  const blocked = new Set<string>();
  let position = 0;
  const available = (room: WindowRoom): number => roomHeadroom(room) - ctx.reserved(room.provider, room.id) - (taken.get(windowKey(room.provider, room.id)) ?? 0);
  for (const candidate of candidates) {
    const takes: Array<{ room: WindowRoom; cost: number }> = [];
    let hold: HoldVerdict | null = null;
    let waitsBehind = false;
    for (const [provider, count] of candidate.demand) {
      const probe = ctx.probe(provider, candidate.run);
      if (probe.state === "override") continue;
      if (probe.state === "unreported") {
        unreported.add(provider);
        continue;
      }
      if (probe.state === "unavailable") {
        if (!hold || Date.parse(probe.verdict.retryAt ?? "") > Date.parse(hold.retryAt ?? "")) hold = probe.verdict;
        continue;
      }
      for (const room of probe.rooms) {
        const { cost, estimated } = candidateCost(candidate, room, ctx, count);
        const free = available(room);
        if (room.used >= room.usable) {
          const until = room.resetsAt ?? ctx.now + 15 * 60_000;
          const verdict: HoldVerdict = { kind: "quota", reason: `${provider} ${room.name} is at ${pts(room.used)}%, above the usable ${pts(room.usable)}%`, provider, window: room.id, retryAt: new Date(until).toISOString() };
          if (!hold || until > Date.parse(hold.retryAt ?? "")) hold = verdict;
          continue;
        }
        // No estimate yet, or an estimate of zero (at most ZERO_COST_POINTS): not paced by cost, only by the hard cap above (and the
        // exhausted or unavailable data checks); it reserves nothing and is not blocked behind a held waiter.
        if (!estimated || cost <= ZERO_COST_POINTS) {
          takes.push({ room, cost: 0 });
          continue;
        }
        if (free + 1e-9 >= cost && !blocked.has(provider)) {
          takes.push({ room, cost });
          continue;
        }
        // Not enough headroom (or a higher candidate waits for this provider first).
        waitsBehind = waitsBehind || free + 1e-9 >= cost;
        const needed = room.used + ctx.reserved(provider, room.id) + cost;
        const at = roomFreeAt(room, needed) ?? ctx.now + 15 * 60_000;
        const verdict: HoldVerdict = {
          kind: "headroom",
          reason: "",
          provider,
          window: room.id,
          retryAt: new Date(Math.max(at, ctx.now + 60_000)).toISOString(),
          estimatedCost: cost,
          headroom: Math.max(0, free),
        };
        if (!hold || (hold.kind !== "quota" && at > Date.parse(hold.retryAt ?? ""))) hold = verdict;
      }
    }
    if (hold) {
      if (hold.kind === "headroom") {
        position += 1;
        hold.position = position;
        hold.priority = candidate.priority;
        hold.reason = `insufficient quota headroom on ${hold.provider} ${hold.window}: ${pts(hold.headroom ?? 0)} points free, ${pts(hold.estimatedCost ?? 0)} estimated for ${candidate.demand.size > 0 ? "this work" : "it"} (from history); priority ${candidate.priority}, ${position === 1 ? "next in the queue" : `position ${position} in the queue`}`;
        for (const provider of candidate.demand.keys()) blocked.add(provider);
      }
      holds.set(candidate.run.id, hold);
      continue;
    }
    for (const take of takes) taken.set(windowKey(take.room.provider, take.room.id), (taken.get(windowKey(take.room.provider, take.room.id)) ?? 0) + take.cost);
    admitted.set(candidate.run.id, Object.fromEntries(takes.map((take) => [windowKey(take.room.provider, take.room.id), take.cost])));
  }
  return { holds, unreported, admitted };
}

/**
 * A run already admitted is only held between steps when a provider's quota is exhausted (a window at or above
 * the usable percent) or its data is unavailable; never for lack of headroom.
 */
export function exhaustionVerdict(providers: string[], ctx: Pick<PlanContext, "now" | "probe">, run?: Run): { verdict: HoldVerdict | null; unreported: Set<string> } {
  const unreported = new Set<string>();
  let worst: HoldVerdict | null = null;
  const consider = (verdict: HoldVerdict) => {
    if (!worst || Date.parse(verdict.retryAt ?? "") > Date.parse(worst.retryAt ?? "")) worst = verdict;
  };
  for (const provider of providers) {
    const probe = ctx.probe(provider, run);
    if (probe.state === "unreported") unreported.add(provider);
    if (probe.state === "unavailable") consider(probe.verdict);
    if (probe.state !== "ok") continue;
    for (const room of probe.rooms) {
      if (room.used < room.usable) continue;
      const until = room.resetsAt ?? ctx.now + 15 * 60_000;
      consider({ kind: "quota", reason: `${provider} ${room.name} is at ${pts(room.used)}%, above the usable ${pts(room.usable)}%`, provider, window: room.id, retryAt: new Date(until).toISOString() });
    }
  }
  return { verdict: worst, unreported };
}

/** An admitted run competing for the capacity: what its started work still has to use, per window key (its reservation's remainder). */
export interface Admitted {
  run: Run;
  priority: number;
  providers: string[];
  need: Record<string, number>;
}

/**
 * Dynamic capacity over admitted runs (ADR 2026-11-21-pause-admitted-runs-to-fit-pace): the runs that may keep progressing are the
 * ones whose remaining cost fits under the pace, taken by priority then oldest first, each taking its need from the headroom
 * (allowed so far minus usage, minus `other` reservations). The rest are paused between steps (never a running step), with their
 * place in the queue. A run that does not fit blocks lower runs on the same provider (a strict order), so resuming goes one by one
 * in that order and never exceeds the capacity. A run with no need (no cost measured, or at most ZERO_COST_POINTS) is not paced and never paused.
 * `quota` and unavailable data are the business of `exhaustionVerdict`, not decided here.
 */
export function planPace(runs: Admitted[], ctx: Pick<PlanContext, "now" | "probe">, other: (provider: string, windowId: string) => number): Map<string, HoldVerdict> {
  const paused = new Map<string, HoldVerdict>();
  const taken = new Map<string, number>();
  const blocked = new Set<string>();
  let position = 0;
  const available = (room: WindowRoom): number => roomHeadroom(room) - other(room.provider, room.id) - (taken.get(windowKey(room.provider, room.id)) ?? 0);
  for (const entry of [...runs].sort((a, b) => b.priority - a.priority || a.run.createdAt.localeCompare(b.run.createdAt) || a.run.id.localeCompare(b.run.id))) {
    const takes: Array<{ room: WindowRoom; cost: number }> = [];
    let short: { room: WindowRoom; cost: number; free: number } | null = null;
    for (const provider of entry.providers) {
      const probe = ctx.probe(provider, entry.run);
      if (probe.state !== "ok") continue;
      for (const room of probe.rooms) {
        const cost = entry.need[windowKey(provider, room.id)] ?? 0;
        if (cost <= ZERO_COST_POINTS) continue;
        const free = available(room);
        if (free + 1e-9 >= cost && !blocked.has(provider)) takes.push({ room, cost });
        else if (!short || free - cost < short.free - short.cost) short = { room, cost, free };
      }
    }
    if (!short) {
      for (const take of takes) taken.set(windowKey(take.room.provider, take.room.id), (taken.get(windowKey(take.room.provider, take.room.id)) ?? 0) + take.cost);
      continue;
    }
    position += 1;
    for (const provider of entry.providers) blocked.add(provider);
    const at = roomFreeAt(short.room, short.room.used + short.cost + other(short.room.provider, short.room.id)) ?? ctx.now + 15 * 60_000;
    paused.set(entry.run.id, {
      kind: "pace",
      reason: `paused to fit the pace on ${short.room.provider} ${short.room.id}: ${pts(Math.max(0, short.free))} points free, ${pts(short.cost)} still estimated for this run; runs resume by priority then oldest as the pace relaxes or other runs finish; priority ${entry.priority}, ${position === 1 ? "next to resume" : `position ${position} in the queue`}`,
      provider: short.room.provider,
      window: short.room.id,
      retryAt: new Date(Math.max(at, ctx.now + 60_000)).toISOString(),
      estimatedCost: short.cost,
      headroom: Math.max(0, short.free),
      position,
      priority: entry.priority,
    });
  }
  return paused;
}

/** The candidates in queue order. */
export function orderCandidates(candidates: Candidate[], runs: Run[]): Candidate[] {
  const order = byQueue(runs);
  // Higher priority first (a manual or playbook priority above a returning run's still wins); then a returning run before one that never started; then oldest.
  return [...candidates].sort((a, b) => runPriority(b.run, runs) - runPriority(a.run, runs) || Number(b.returning ?? false) - Number(a.returning ?? false) || order(a.run, b.run));
}

export { runPriority };
