import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "../shared/types";
import type { RateLimitsConfig } from "./config";
import { byQueue, roomFreeAt, roomHeadroom, runPriority, type HoldVerdict, type Probe, type WindowRoom } from "./rate-limit";

/**
 * Dynamic capacity (ADR 2026-11-20-dynamic-rate-limits): the work that may start is what the quota headroom covers. Headroom of a
 * usage window = its pace ceiling minus current usage minus what started work still has to use; work starts while the headroom
 * covers its estimated cost. This file holds the cost history and the admission plan; the runtime applies them. All amounts are
 * quota points (percent of a usage window).
 */

/** The unit the headroom of a window is kept in: provider and window id. */
export const windowKey = (provider: string, windowId: string): string => `${provider}\u0000${windowId}`;

interface Sample {
  points: number;
  steps: number;
}

/**
 * What agent steps cost in quota, per playbook, provider and window: points used / steps finished, measured from the usage
 * readings (the runtime attributes each reading's increase to the steps running in the interval). Kept in a file so it survives a reload.
 */
export class CostHistory {
  private data = new Map<string, Sample>();

  constructor(private readonly file: string | null = null) {
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Sample>;
        for (const [key, sample] of Object.entries(parsed)) if (sample && Number.isFinite(sample.points) && sample.steps > 0) this.data.set(key, { points: sample.points, steps: sample.steps });
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

  /** How many finished steps the average of this playbook on the provider rests on (the smallest over its windows seen). */
  samples(playbookId: string, provider: string): number {
    let count = 0;
    for (const [key, sample] of this.data) if (key.startsWith(`${playbookId}|${provider}\u0000`)) count = count === 0 ? sample.steps : Math.min(count, sample.steps);
    return count;
  }

  /** Records one finished step: its points per window. */
  add(playbookId: string, provider: string, points: Record<string, number>): void {
    for (const [windowId, value] of Object.entries(points)) {
      const key = this.key(playbookId, provider, windowId);
      const sample = this.data.get(key) ?? { points: 0, steps: 0 };
      // Old steps weigh less: after 200 samples each new one replaces a 200th of the average.
      const keep = sample.steps >= 200 ? sample.steps - 1 : sample.steps;
      this.data.set(key, { points: (sample.points * keep) / Math.max(sample.steps, 1) + value, steps: keep + 1 });
    }
  }

  async save(): Promise<void> {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.data)), "utf8");
    await rename(tmp, this.file);
  }
}

/** Run work that waits for headroom: how many agent steps it wants to start on each provider. */
export interface Candidate {
  run: Run;
  priority: number;
  /** provider → number of steps (all the run's remaining agent steps). */
  demand: Map<string, number>;
}

export interface PlanContext {
  now: number;
  config: RateLimitsConfig;
  /** The provider's usage rooms, seen through the limits of `run` (its own `usable_percent`); without a run, the user-level limits. */
  probe: (provider: string, run?: Run) => Probe;
  /** Points one step of the run's playbook is expected to use on the window: its measured history; null while there is none (not paced by estimate). */
  stepCost: (run: Run, provider: string, windowId: string) => number | null;
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

const pts = (value: number) => `${Math.round(value * 10) / 10}`;

/** The estimated cost of a candidate on one window: steps × per-step cost, never above what the window can ever hold. */
export function candidateCost(candidate: Candidate, room: WindowRoom, ctx: PlanContext, count: number): { cost: number; estimated: boolean } {
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
        // No estimate yet (no measure yet): not paced by cost, only by the hard cap above; it reserves nothing.
        if (!estimated) {
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
 * (pace ceiling minus usage, minus `other` reservations). The rest are paused between steps (never a running step), with their
 * place in the queue. A run that does not fit blocks lower runs on the same provider (a strict order), so resuming goes one by one
 * in that order and never exceeds the capacity. A run with no need (no cost measured) is not paced and never paused.
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
        if (cost <= 1e-9) continue;
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
  return [...candidates].sort((a, b) => order(a.run, b.run));
}

export { runPriority };
