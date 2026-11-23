import type { QuotaLimitation, QuotaProject, QuotaProjectLimits, QuotaProvider, QuotaWindow } from "../shared/quota-limitation";

/**
 * The Quota limitation tab's rows: for each project (and each set of limits among its playbooks) what each provider's usage
 * windows look like to it. Pure: the server sends the global figures, the pace per distinct `usable_percent`, and the runs with
 * their project; this picks the pace that belongs to the project and lays the bar out.
 */

/** A bar, in percent of its track: grey from 0 to `grey`, green from `greenFrom` for `green`, red from `redFrom` for `red`, a tick at `tick` (null: unpaced). */
export interface Bar {
  grey: number;
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
  /** Usage above the pace ceiling, 0 when none. */
  over: number;
  resetsAt: string | null;
  stale: boolean;
  bar: Bar;
}

export type ProviderStatus = "over" | "unavailable" | "ok" | "unreported" | "off";

export interface ProviderRow {
  provider: string;
  status: ProviderStatus;
  state: QuotaProvider["state"];
  readAt: string | null;
  overrideUntil: string | null;
  slots: SlotRow[];
  /** Smallest `free` over the paced windows; null when none is paced. */
  free: number | null;
  reservations: QuotaProvider["reservations"];
  held: QuotaProvider["held"];
  exhausted: QuotaProvider["exhausted"];
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
  /** Worst state over every set and provider. */
  tone: Tone;
  pacing: boolean;
  /** Distinct usable percents of the sets with pacing on. */
  percents: number[];
  /** What to say per provider in the collapsed line (only where the project paces). */
  summary: Array<{ provider: string; status: ProviderStatus; free: number | null }>;
  stepsLimit: number | null;
  runsLimit: number | null;
}

const round = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number) => Math.min(100, Math.max(0, value));

/** The bar of a window: usage grey up to the ceiling, the excess red, the free room green after the reservations, a tick at the ceiling. */
export function barOf(used: number | null, ceiling: number | null, free: number | null, reserved: number): Bar {
  const u = used ?? 0;
  const full = Math.max(100, u);
  const pct = (value: number) => clamp((value / full) * 100);
  if (ceiling === null) return { grey: pct(u), greenFrom: 0, green: 0, redFrom: 0, red: 0, tick: null };
  const grey = Math.min(u, ceiling);
  const greenStart = u + reserved;
  const green = Math.max(0, Math.min(free ?? 0, ceiling - greenStart));
  return { grey: pct(grey), greenFrom: pct(greenStart), green: pct(greenStart + green) - pct(greenStart), redFrom: pct(ceiling), red: u > ceiling ? pct(u) - pct(ceiling) : 0, tick: pct(ceiling) };
}

function slotRow(slot: QuotaWindow, set: QuotaProjectLimits, label: string): SlotRow {
  const pace = set.pacing && !slot.modelScoped ? slot.paces.find((candidate) => candidate.usable === set.usablePercent && candidate.projects.includes(label)) : undefined;
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
    bar: barOf(slot.used, ceiling, free, slot.reserved),
  };
}

function providerRow(provider: QuotaProvider, set: QuotaProjectLimits, project: QuotaProject): ProviderRow {
  const slots = provider.windows.map((slot) => slotRow(slot, set, project.label));
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
  return { provider: provider.provider, status, state: provider.state, readAt: provider.readAt, overrideUntil: provider.overrideUntil, slots, free, reservations: mine(provider.reservations), held: mine(provider.held), exhausted: mine(provider.exhausted) };
}

const STATUS_RANK: Record<ProviderStatus, number> = { over: 3, unavailable: 2, unreported: 1, ok: 0, off: 0 };

/** One row per project, sorted as the server sent them. */
export function projectRows(data: QuotaLimitation): ProjectRow[] {
  return data.projects.map((project) => {
    const sets = project.limits.map((limits) => ({ limits, providers: data.providers.map((provider) => providerRow(provider, limits, project)) }));
    const pacing = sets.some((set) => set.limits.pacing);
    // The collapsed line: per provider the worst status over the sets that pace, the smallest free.
    const byProvider = new Map<string, { provider: string; status: ProviderStatus; free: number | null }>();
    for (const set of sets) {
      if (!set.limits.pacing) continue;
      for (const row of set.providers) {
        const before = byProvider.get(row.provider);
        const worse = !before || STATUS_RANK[row.status] > STATUS_RANK[before.status];
        const free = before?.free === null || before?.free === undefined ? row.free : row.free === null ? before.free : Math.min(before.free, row.free);
        byProvider.set(row.provider, { provider: row.provider, status: worse ? row.status : before.status, free });
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
      tone,
      pacing,
      percents: [...new Set(project.limits.filter((limits) => limits.pacing).map((limits) => limits.usablePercent))],
      summary,
      stepsLimit: steps.find((limit) => limit !== null) ?? null,
      runsLimit: runs.find((limit) => limit !== null) ?? null,
    };
  });
}
