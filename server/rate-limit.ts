import type { RateHold, Run } from "../shared/types";
import { isActive, isPaused, isPipeline } from "../shared/types";
import type { RateLimitsConfig } from "./config";
import { windowModel, type ProviderUsage, type UsageSnapshot, type UsageWindow } from "./usage";

/**
 * Rate limiting of playbook steps (ADR 2026-11-20-rate-limiting): global limits on running steps and admitted runs, and
 * pacing against each provider's usage windows. This file holds the decisions; the runtime applies them between steps and
 * lifts them by itself. A running step is never interrupted.
 */

/** What the limiter says about a run that wants to start a step: held (with why) or free to go. */
export type HoldVerdict = Pick<RateHold, "kind" | "reason" | "provider" | "window" | "retryAt"> & Partial<Pick<RateHold, "estimatedCost" | "headroom" | "position" | "priority">>;

const HOUR = 3_600_000;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, twelve: 12, twenty: 20 };

/** The length of a usage window, from its id or label (`five_hour`, `5h`, `weekly`, `7-day`), or null when it cannot be told. */
export function windowLengthMs(window: Pick<UsageWindow, "id" | "label"> & { windowMinutes?: number | null }): number | null {
  if (typeof window.windowMinutes === "number" && window.windowMinutes > 0) return window.windowMinutes * 60_000;
  const text = `${window.id} ${window.label ?? ""}`.toLowerCase();
  const count = /(\d+)\s*[-_ ]?\s*(h|hr|hrs|hour|hours|d|day|days)\b/.exec(text);
  if (count) return Number(count[1]) * (count[2]!.startsWith("h") ? HOUR : 24 * HOUR);
  const word = /\b(one|two|three|four|five|six|seven|eight|ten|twelve|twenty)[-_ ]?(hour|day)/.exec(text);
  if (word) return WORDS[word[1]!]! * (word[2] === "hour" ? HOUR : 24 * HOUR);
  if (/week/.test(text)) return 7 * 24 * HOUR;
  if (/month/.test(text)) return 30 * 24 * HOUR;
  if (/dai?ly|\bday\b/.test(text)) return 24 * HOUR;
  if (/hour/.test(text)) return HOUR;
  return null;
}

/**
 * The cumulative ceiling (percent) of a window at `now`: `usable * elapsed / length`, so a 100-hour window with 97 usable
 * allows 0.97 points an hour. Null when the window's length or reset time is unknown.
 */
export function paceCeiling(window: UsageWindow & { windowMinutes?: number | null }, usable: number, nowMs: number): { ceiling: number; startMs: number; lengthMs: number } | null {
  const length = windowLengthMs(window);
  const resets = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (!length || !Number.isFinite(resets)) return null;
  const startMs = resets - length;
  const elapsed = Math.min(length, Math.max(0, nowMs - startMs));
  return { ceiling: (usable * elapsed) / length, startMs, lengthMs: length };
}

export function usedPct(window: UsageWindow): number | null {
  return window.usedPct ?? (window.remainingPct !== undefined && window.remainingPct !== null ? 100 - window.remainingPct : null);
}

const pct = (value: number) => `${Math.round(value * 10) / 10}%`;

/** One provider-wide usage window with what the pacing needs of it. Percent points of the window throughout. */
export interface WindowRoom {
  provider: string;
  id: string;
  name: string;
  used: number;
  /** The most the playbooks may have used by now: the pace ceiling, never above the usable percent (the hard cap). */
  ceiling: number;
  usable: number;
  /** Window start and length (ms) when known (the pace ceiling needs both); null for a window with no pace. */
  startMs: number | null;
  lengthMs: number | null;
  resetsAt: number | null;
}

/** The room left in a window before reservations: the pace ceiling minus usage (negative when usage is ahead of the pace). */
export const roomHeadroom = (room: WindowRoom): number => room.ceiling - room.used;

/**
 * The provider-wide windows of a usage entry that can be paced on: those that report usage and have not already reset (a
 * reading whose window reset is stale; the next refresh settles it). A window whose length is unknown only has the hard cap.
 */
export function windowRooms(entry: ProviderUsage, usable: number, nowMs: number): WindowRoom[] {
  const rooms: WindowRoom[] = [];
  for (const window of entry.windows ?? []) {
    if (windowModel(window.id)) continue;
    const used = usedPct(window);
    if (used === null) continue;
    const resets = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(resets) && resets <= nowMs) continue;
    const pace = paceCeiling(window, usable, nowMs);
    rooms.push({ provider: entry.providerId, id: window.id, name: window.label ?? window.id, used, ceiling: pace ? Math.min(pace.ceiling, usable) : usable, usable, startMs: pace?.startMs ?? null, lengthMs: pace?.lengthMs ?? null, resetsAt: Number.isFinite(resets) ? resets : null });
  }
  return rooms;
}

/** When `needed` points (usage plus reservations plus the cost) fit under the pace ceiling, or the window's reset when they never will; null when unknown. */
export function roomFreeAt(room: WindowRoom, needed: number): number | null {
  if (needed >= room.usable) return room.resetsAt;
  if (room.startMs === null || room.lengthMs === null) return null;
  return room.startMs + (needed / room.usable) * room.lengthMs;
}

/** Waits between failed reads of the usage endpoint, in order (the last repeats). */
export const QUOTA_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];

/** The default length of a "continue anyway" override, and its longest. */
export const OVERRIDE_DEFAULT_MS = HOUR;
export const OVERRIDE_MAX_MS = 24 * HOUR;

export interface Reading {
  entry: ProviderUsage | null;
  /** When a successful read produced it. */
  at: number;
}

/** What a successful read changed, per provider: the reading before (null the first time) and after. */
export interface ReadChange {
  provider: string;
  before: Reading | null;
  after: Reading;
}

/** What the pacing knows about a provider now. */
export type Probe =
  /** "Continue anyway" is on: not paced. */
  | { state: "override" }
  /** No fresh enough reading: new work is held with this verdict. */
  | { state: "unavailable"; verdict: HoldVerdict }
  /** The provider reports no usage (no entry, not available, no window): it cannot be paced. */
  | { state: "unreported" }
  | { state: "ok"; rooms: WindowRoom[] };

/** One provider as the pacing sees it now (see `QuotaPacer.view`). */
export interface PacerView {
  provider: string;
  state: "ok" | "override" | "unavailable" | "unreported";
  /** When the usage was last read (ms), null when never. */
  readAt: number | null;
  overrideUntil: number | null;
  entry: ProviderUsage | null;
}

/**
 * The provider usage the quota pacing decides from. A reading younger than `refreshMs` is used; an older one under `maxAgeMs`
 * still decides while one background refresh runs; an older one holds with "quota data unavailable". A failed read never
 * touches the readings and is retried with a backoff. `onChange` is called when a read succeeds (with what changed), so held runs are released at once.
 */
export class QuotaPacer {
  private readings = new Map<string, Reading>();
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private nextAttempt = 0;
  private overrides = new Map<string, number>();
  /** Providers asked about, so a read records "no entry" for one the daemon does not list. */
  private asked = new Set<string>();

  constructor(
    private readonly fetch: () => Promise<UsageSnapshot>,
    private readonly onChange: (changes: ReadChange[]) => void = () => undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  /** What the pacing knows about `provider` now (and starts a background refresh when its reading is due). */
  probe(provider: string, config: RateLimitsConfig["quota"]): Probe {
    const now = this.clock();
    this.asked.add(provider);
    const until = this.overrides.get(provider);
    if (until !== undefined && until > now) return { state: "override" };
    const reading = this.readings.get(provider);
    const age = reading ? now - reading.at : Infinity;
    if (age >= config.refreshMs) this.refresh();
    if (!reading || age > config.maxAgeMs) {
      return { state: "unavailable", verdict: { kind: "quota", reason: `quota data unavailable for ${provider}`, provider, window: null, retryAt: new Date(Math.max(now, this.nextAttempt)).toISOString() } };
    }
    const entry = reading.entry;
    if (!entry || (entry.status !== undefined && entry.status !== "available")) return { state: "unreported" };
    const rooms = windowRooms(entry, config.usablePercent, now);
    return rooms.length === 0 ? { state: "unreported" } : { state: "ok", rooms };
  }

  /** Starts a read unless one is running or the backoff has not ended (single-flight). */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.clock() < this.nextAttempt) return Promise.resolve();
    this.inflight = this.load().finally(() => void (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<void> {
    try {
      const snapshot = await this.fetch();
      const at = this.clock();
      const before = new Map(this.readings);
      this.failures = 0;
      this.nextAttempt = 0;
      for (const provider of this.asked) this.readings.set(provider, { entry: null, at });
      for (const entry of snapshot.providers) this.readings.set(entry.providerId, { entry, at });
      const changes = [...this.readings].map(([provider, after]) => ({ provider, before: before.get(provider) ?? null, after })).filter((change) => change.after.at === at);
      this.onChange(changes);
    } catch {
      this.nextAttempt = this.clock() + QUOTA_BACKOFF_MS[Math.min(this.failures, QUOTA_BACKOFF_MS.length - 1)]!;
      this.failures += 1;
    }
  }

  /** Lets steps of runs that use `provider` start for `ms` (default one hour, at most a day) despite the pacing. */
  override(provider: string, ms: number = OVERRIDE_DEFAULT_MS): string {
    const until = this.clock() + Math.min(Math.max(ms, 60_000), OVERRIDE_MAX_MS);
    this.overrides.set(provider, until);
    this.onChange([]);
    return new Date(until).toISOString();
  }

  clearOverride(provider: string): void {
    this.overrides.delete(provider);
  }

  /** What the pacing holds about every provider it has a reading or a question for, for the Quota limitation tab (reads only; starts a refresh when one is due). */
  view(config: RateLimitsConfig["quota"]): PacerView[] {
    const now = this.clock();
    if (this.readings.size === 0 || [...this.readings.values()].some((reading) => now - reading.at >= config.refreshMs)) void this.refresh();
    const ids = new Set([...this.readings.keys(), ...this.asked]);
    return [...ids].sort().map((provider) => {
      const reading = this.readings.get(provider);
      const until = this.overrides.get(provider);
      const age = reading ? now - reading.at : Infinity;
      const entry = reading?.entry ?? null;
      let state: PacerView["state"];
      if (until !== undefined && until > now) state = "override";
      else if (!reading || age > config.maxAgeMs) state = "unavailable";
      else if (!entry || (entry.status !== undefined && entry.status !== "available") || windowRooms(entry, config.usablePercent, now).length === 0) state = "unreported";
      else state = "ok";
      return { provider, state, readAt: reading ? reading.at : null, overrideUntil: until !== undefined && until > now ? until : null, entry };
    });
  }

  /** The active overrides: provider → ISO end. */
  activeOverrides(): Record<string, string> {
    const now = this.clock();
    return Object.fromEntries([...this.overrides].filter(([, until]) => until > now).map(([provider, until]) => [provider, new Date(until).toISOString()]));
  }
}

// ---------------------------------------------------------------- global limits

/** Steps that count against the step limit: running agent and script steps of active runs. A gate, a hand-off and a fan-out are not work (a fan-out step waits for runs that need the capacity it would hold). */
export function runningStepCount(runs: Run[]): number {
  let count = 0;
  for (const run of runs) {
    if (run.archivedAt || isPipeline(run) || !isActive(run)) continue;
    for (const step of run.playbook.steps) if ((step.kind === "agent" || step.kind === "script") && run.steps[step.id]?.status === "running") count += 1;
  }
  return count;
}

/** The queue priority of a run: its own (`start_playbook`), else its playbook's `quota_limit.priority`; a fan-out child follows its parent's. Higher goes first. */
export function runPriority(run: Run, runs: Run[]): number {
  const root = run.parent ? runs.find((candidate) => candidate.id === run.parent?.runId) : undefined;
  const owner = root ?? run;
  return owner.priority ?? owner.playbook.rateLimit.priority;
}

/** Whether any agent or script step of the run has started (the run is past admission). */
export const hasStarted = (run: Run): boolean => Object.values(run.steps).some((state) => state.attempts.length > 0);

/** Queue order: higher priority first, ties oldest first. */
export const byQueue = (runs: Run[]) => (a: Run, b: Run) => runPriority(b, runs) - runPriority(a, runs) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The runs the optional playbook cap admits: runs already started first (an admitted run is never pre-empted), then by priority,
 * then the oldest, up to `limit` (a stable order, so a hold never alternates between runs). A run started by a fan-out belongs to its
 * parent's admission, and a pipeline or an ended run takes no place. A run with a step running is always admitted: the cap only holds between steps.
 */
export function admittedRunIds(runs: Run[], limit: number | null): Set<string> | null {
  if (limit === null) return null;
  const queue = byQueue(runs);
  const candidates = runs.filter((run) => !run.archivedAt && !run.parent && !isPipeline(run) && isActive(run) && !isPaused(run)).sort((a, b) => Number(hasStarted(b)) - Number(hasStarted(a)) || queue(a, b));
  const admitted = new Set<string>();
  for (const run of candidates) if (admitted.size < limit) admitted.add(run.id);
  return admitted;
}

/** The providers a run's agent steps start on (the primary target of each step's chain; a step with no provider uses `fallbackProvider`). */
export function runProviders(run: Run, fallbackProvider: string): string[] {
  const providers = new Set<string>();
  for (const step of run.playbook.steps) {
    if (step.kind !== "agent") continue;
    const status = run.steps[step.id]?.status;
    if (status === "completed" || status === "skipped") continue;
    providers.add(step.agent.provider ?? fallbackProvider);
  }
  return [...providers];
}

/** The hold the global limits put on `run` wanting to start a step now, or null. `reserved` are steps already being started. */
export function limitVerdict(run: Run, runs: Run[], config: Pick<RateLimitsConfig, "steps" | "playbooks">, reserved: number): HoldVerdict | null {
  const admitted = admittedRunIds(runs, config.playbooks);
  const root = run.parent ? runs.find((candidate) => candidate.id === run.parent?.runId) : undefined;
  const owner = root ?? run;
  if (admitted && !admitted.has(owner.id) && !Object.values(run.steps).some((state) => state.status === "running")) {
    return { kind: "playbooks", reason: `playbook limit reached: ${config.playbooks} run${config.playbooks === 1 ? "" : "s"} at a time; this run waits until one ends or the limit rises`, provider: null, window: null, retryAt: null };
  }
  if (config.steps !== null && runningStepCount(runs) + reserved >= config.steps) {
    return { kind: "steps", reason: `step limit reached: ${config.steps} step${config.steps === 1 ? "" : "s"} running at a time; the next step starts when one ends`, provider: null, window: null, retryAt: null };
  }
  return null;
}
