import type { QuotaBurnRate, QuotaLimitation, QuotaRunRef, QuotaProject, QuotaProjectLimits, QuotaProvider, QuotaWindow } from "../shared/quota-limitation";

/**
 * The Burn rate limiting tab's rows: for each project (and each set of limits among its playbooks) what each provider's usage
 * windows look like to it. Pure: the server sends the global figures, the pace per distinct `usable_percent`, and the runs with
 * their project; this picks the pace that belongs to the project and lays the bar out.
 */

/** A bar, in percent of its track: grey from 0 to `grey`, blue (the reservations) from `blueFrom` for `blue`, green from `greenFrom` for `green`, red from `redFrom` for `red`, a tick at `tick` (null: unpaced). */
export interface Bar {
  grey: number;
  blueFrom: number;
  blue: number;
  greenFrom: number;
  green: number;
  redFrom: number;
  red: number;
  tick: number | null;
}

export interface SlotRow {
  id: string;
  name: string;
  modelScoped: boolean;
  used: number | null;
  reserved: number;
  /** Paced for this project: pacing on, a pace figure for its percent, not a model-scoped one */
  paced: boolean;
  ceiling: number | null;
  /** Ceiling minus usage and reservations (negative: over). */
  free: number | null;
  /** Usage above what is allowed so far, 0 when none. */
  over: number;
  resetsAt: string | null;
  stale: boolean;
  /** Paced with closed hours and now in a closed slot: what is allowed so far is flat. */
  frozen: boolean;
  /** Closed hours are set but the window has no open hour: the plain linear rule applies. */
  closedIgnored: boolean;
  bar: Bar;
}

export type ProviderStatus = "over" | "unavailable" | "ok" | "unreported" | "off";

/**
 * How much a project's new work with a real cost is held on a provider, from what the row already has.
 * `percent` = the largest over the paced windows of clamp(1 - free / need, 0, 1): `free` is the window's headroom minus every
 * reservation (the planner's own test: a run starts when free covers its cost), `need` the median remaining need of the project's
 * runs admitted or queued on the provider (a held run counts with its estimated cost), else the largest measured cost of one step of
 * its playbooks. Nothing over ZERO_NEED counts: a zero-cost run, or none with history, gives `percent: null` ("no estimate").
 */
export interface Throttle {
  /** 0 to 100, rounded; null: paced but no measured cost to compare with, so nothing is held for cost. */
  percent: number | null;
  /** Where the need comes from: the project's runs, or its playbooks' measured step cost. */
  source: "runs" | "playbooks" | null;
  held: number;
  paused: number;
  /** The oldest hold's age in ms, null with no hold. */
  longestWaitMs: number | null;
  /** The next time a held or paused run is looked at again (ISO), null when none has one. */
  nextRetryAt: string | null;
}

export interface ProviderRow {
  provider: string;
  status: ProviderStatus;
  state: QuotaProvider["state"];
  readAt: string | null;
  /** The provider's usage reading is unavailable now: its windows are the last known ones (stale), and headroom and throttle are unknown. */
  unavailable: boolean;
  overrideUntil: string | null;
  slots: SlotRow[];
  /** Smallest `free` over the paced windows; null when none is paced. */
  free: number | null;
  /** The project's runs that reserve quota, plus the held or paused ones that reserve none yet, each tagged when held or paused. */
  reservations: ReservationRow[];
  exhausted: QuotaProvider["exhausted"];
  throttle: Throttle;
}

/** A run under "Reservations": what it still has to use (empty for a held run that reserves nothing yet) and a short tag when rate limiting holds it. */
export interface ReservationRow extends QuotaRunRef {
  remaining: Record<string, number>;
  /** Not subject to burn rate limiting: reserves quota, never held or paused. */
  exempt?: boolean;
  /** Per window id: the remaining need is agent time x burn rate (ms left, percent points per hour). */
  basis?: Record<string, { ms: number; burnRate: number }>;
  hold: "held" | "paused" | null;
}

export interface SetRow {
  limits: QuotaProjectLimits;
  providers: ProviderRow[];
}

export type Tone = "over" | "warn" | "ok" | "off";

export interface ProjectRow {
  projectId: string;
  label: string;
  sets: SetRow[];
  /** The burn rate learned per playbook of the project, with the reset controls' data. */
  burnRates: QuotaBurnRate[];
  /** Worst state over every set and provider. */
  tone: Tone;
  pacing: boolean;
  /** Distinct usable percents of the sets with pacing on. */
  percents: number[];
  /** What to say per provider in the collapsed line (only where the project paces). */
  summary: Array<{ provider: string; status: ProviderStatus; free: number | null; over: number }>;
  /** Some provider is throttled for this project: new work with a real cost is held (throttle above 0). */
  throttled: boolean;
  stepsLimit: number | null;
  runsLimit: number | null;
}

/** A need at or below this many points is zero (the planner's ZERO_COST_POINTS). */
const ZERO_NEED = 0.05;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The throttle of a provider for a project (see `Throttle`). Without pacing, or with no paced window, `percent` is null. */
export function throttleOf(input: { slots: SlotRow[]; reservations: ReservationRow[]; held: QuotaProvider["held"]; unitCost: Record<string, number> | undefined; nowMs: number }): Throttle {
  const { slots, reservations, held, unitCost, nowMs } = input;
  let percent: number | null = null;
  let source: Throttle["source"] = null;
  for (const slot of slots.filter((candidate) => candidate.paced)) {
    // An exempt run reserves quota but is no waiting work: it does not set the typical need the throttle is measured against.
    const own = reservations.filter((run) => !run.exempt).map((run) => run.remaining[slot.id] ?? 0);
    // A held run with no reservation yet counts with the cost the hold estimated.
    for (const run of held) if (run.window === slot.id && run.estimatedCost && !reservations.some((reserved) => reserved.runId === run.runId && (reserved.remaining[slot.id] ?? 0) > 0)) own.push(run.estimatedCost);
    const needs = own.filter((value) => value > ZERO_NEED);
    const fallback = unitCost?.[slot.id];
    const need = needs.length > 0 ? median(needs) : fallback !== undefined && fallback > ZERO_NEED ? fallback : null;
    if (need === null) continue;
    const value = Math.round(Math.min(1, Math.max(0, 1 - (slot.free ?? 0) / need)) * 100);
    if (percent === null || value > percent) {
      percent = value;
      source = needs.length > 0 ? "runs" : "playbooks";
    }
  }
  const since = held.flatMap((run) => (run.since && Number.isFinite(Date.parse(run.since)) ? [Date.parse(run.since)] : []));
  const retries = held.flatMap((run) => (run.retryAt && Number.isFinite(Date.parse(run.retryAt)) ? [Date.parse(run.retryAt)] : []));
  const upcoming = retries.filter((at) => at >= nowMs);
  const next = upcoming.length > 0 ? Math.min(...upcoming) : retries.length > 0 ? Math.min(...retries) : null;
  return {
    percent,
    source,
    held: held.filter((run) => run.kind !== "pace").length,
    paused: held.filter((run) => run.kind === "pace").length,
    longestWaitMs: since.length > 0 ? Math.max(0, nowMs - Math.min(...since)) : null,
    nextRetryAt: next === null ? null : new Date(next).toISOString(),
  };
}

const round = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number) => Math.min(100, Math.max(0, value));

/** The bar of a window: usage grey up to the ceiling, the excess violet, the reservations blue right after the usage (clamped to the track), the free room green after the reservations, a tick at the ceiling. */
export function barOf(used: number | null, ceiling: number | null, free: number | null, reserved: number): Bar {
  const u = used ?? 0;
  const full = Math.max(100, u);
  const pct = (value: number) => clamp((value / full) * 100);
  if (ceiling === null) return { grey: pct(u), blueFrom: 0, blue: 0, greenFrom: 0, green: 0, redFrom: 0, red: 0, tick: null };
  const grey = Math.min(u, ceiling);
  const greenStart = u + reserved;
  const green = Math.max(0, Math.min(free ?? 0, ceiling - greenStart));
  const blue = Math.max(0, Math.min(reserved, full - u));
  return { grey: pct(grey), blueFrom: pct(u), blue: pct(u + blue) - pct(u), greenFrom: pct(greenStart), green: pct(greenStart + green) - pct(greenStart), redFrom: pct(ceiling), red: u > ceiling ? pct(u) - pct(ceiling) : 0, tick: pct(ceiling) };
}

function slotRow(slot: QuotaWindow, set: QuotaProjectLimits, label: string): SlotRow {
  const pace = set.pacing && !slot.modelScoped ? slot.paces.find((candidate) => candidate.usable === set.usablePercent && (candidate.closedKey ?? null) === (set.closedKey ?? null) && candidate.projects.includes(label)) : undefined;
  const ceiling = pace?.ceiling ?? null;
  const free = pace?.free ?? null;
  return {
    id: slot.id,
    name: slot.name,
    modelScoped: slot.modelScoped,
    used: slot.used,
    reserved: slot.reserved,
    paced: Boolean(pace),
    ceiling,
    free,
    over: pace && slot.used !== null ? Math.max(0, round(slot.used - pace.ceiling)) : 0,
    resetsAt: slot.resetsAt,
    stale: slot.stale,
    frozen: pace?.frozen === true,
    closedIgnored: pace?.closedIgnored === true,
    bar: barOf(slot.used, ceiling, free, slot.reserved),
  };
}

function providerRow(provider: QuotaProvider, set: QuotaProjectLimits, project: QuotaProject, nowMs: number): ProviderRow {
  const unavailable = provider.state === "unavailable" || provider.usage?.available === false;
  // While the reading is unavailable the windows are the last known ones: stale, whatever their reset says.
  const slots = provider.windows.map((slot) => ({ ...slotRow(slot, set, project.label), ...(unavailable ? { stale: true } : {}) }));
  const pacedSlots = slots.filter((slot) => slot.paced);
  const free = pacedSlots.length > 0 ? Math.min(...pacedSlots.map((slot) => slot.free ?? 0)) : null;
  const mine = <T extends { projectId?: string | undefined }>(items: T[]) => items.filter((item) => item.projectId === undefined || item.projectId === project.projectId);
  const status: ProviderStatus = !set.pacing
    ? "off"
    : provider.state === "unavailable"
      ? "unavailable"
      : provider.state === "unreported"
        ? "unreported"
        : pacedSlots.some((slot) => slot.over > 0)
          ? "over"
          : "ok";
  const held = new Map(mine(provider.held).map((run) => [run.runId, run.kind]));
  const tag = (runId: string): ReservationRow["hold"] => (held.has(runId) ? (held.get(runId) === "pace" ? "paused" : "held") : null);
  const reserving = mine(provider.reservations);
  const reservations: ReservationRow[] = [
    ...reserving.map((run) => ({ ...run, hold: tag(run.runId) })),
    ...mine(provider.held)
      .filter((run) => !reserving.some((reserved) => reserved.runId === run.runId))
      .map(({ kind: _kind, reason: _reason, window: _window, retryAt: _retryAt, ...run }) => ({ ...run, remaining: {}, exempt: false, hold: tag(run.runId) })),
  ];
  const throttle = throttleOf({ slots, reservations, held: mine(provider.held), unitCost: project.unitCost?.[provider.provider], nowMs });
  return { provider: provider.provider, status, state: provider.state, readAt: provider.readAt, unavailable, overrideUntil: provider.overrideUntil, slots, free, reservations, exhausted: mine(provider.exhausted), throttle: set.pacing && !unavailable ? throttle : { ...throttle, percent: null, source: null } };
}

const STATUS_RANK: Record<ProviderStatus, number> = { over: 3, unavailable: 2, unreported: 1, ok: 0, off: 0 };

/** One row per project, sorted as the server sent them. */
export function projectRows(data: QuotaLimitation): ProjectRow[] {
  return data.projects.map((project) => {
    const sets = project.limits.map((limits) => ({ limits, providers: data.providers.map((provider) => providerRow(provider, limits, project, Date.parse(data.now))) }));
    const pacing = sets.some((set) => set.limits.pacing);
    // The collapsed line: per provider the worst status over the sets that pace, the smallest free.
    const byProvider = new Map<string, { provider: string; status: ProviderStatus; free: number | null; over: number }>();
    for (const set of sets) {
      if (!set.limits.pacing) continue;
      for (const row of set.providers) {
        const before = byProvider.get(row.provider);
        const worse = !before || STATUS_RANK[row.status] > STATUS_RANK[before.status];
        const free = before?.free === null || before?.free === undefined ? row.free : row.free === null ? before.free : Math.min(before.free, row.free);
        const over = Math.max(before?.over ?? 0, ...row.slots.map((slot) => slot.over));
        byProvider.set(row.provider, { provider: row.provider, status: worse ? row.status : before.status, free, over });
      }
    }
    const summary = [...byProvider.values()];
    const worst = summary.reduce((rank, item) => Math.max(rank, STATUS_RANK[item.status]), 0);
    const tone: Tone = !pacing ? "off" : worst >= 3 ? "over" : worst >= 1 || summary.some((item) => item.free !== null && item.free <= 0) ? "warn" : "ok";
    const steps = project.limits.map((limits) => limits.stepsLimit);
    const runs = project.limits.map((limits) => limits.runsLimit);
    return {
      projectId: project.projectId,
      label: project.label,
      sets,
      burnRates: project.burnRates ?? [],
      tone,
      pacing,
      percents: [...new Set(project.limits.filter((limits) => limits.pacing).map((limits) => limits.usablePercent))],
      summary,
      throttled: sets.some((set) => set.limits.pacing && set.providers.some((row) => (row.throttle.percent ?? 0) > 0)),
      stepsLimit: steps.find((limit) => limit !== null) ?? null,
      runsLimit: runs.find((limit) => limit !== null) ?? null,
    };
  });
}

/** "2h 5m", "14m", "<1m": a wait in hours and minutes. */
export function formatWait(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** The providers whose usage reading is unavailable now, for the provider-level line (once per provider, not per project row). */
export function unavailableProviders(data: QuotaLimitation): Array<{ provider: string; since: string | null; reason: string | null; lastReadAt: string | null }> {
  return data.providers.flatMap((provider) => (provider.usage?.available === false ? [{ provider: provider.provider, since: provider.usage.since, reason: provider.usage.reason, lastReadAt: provider.usage.lastReadAt ?? provider.readAt }] : []));
}
