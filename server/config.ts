import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { pluginDataDir } from "./data-dir";
import { DEFAULT_REPO } from "../shared/repos";
import { parseDuration } from "../shared/vars";
import { dayNumbers, parseClock, validTimezone, type ClosedHours } from "./closed-hours";

/** `<plugin data dir>/config.yaml` (data-dir.ts): the user's settings (profile activation is per project). */
export function userConfigFile(): string {
  return path.join(pluginDataDir(), "config.yaml");
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const value = parseYaml(await readFile(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The profiles a project has turned on: `profiles.projects.<project>.active` of the user config. It applies to every
 * workspace of the project. Anything malformed, `default` and repeats are dropped: a bad config never blocks loading.
 * The old global `profiles.active` is ignored: a project without an entry has no profile active.
 */
export async function readProjectProfiles(projectId: string, file: string = userConfigFile()): Promise<string[]> {
  const projects = asRecord(asRecord((await readConfig(file)).profiles).projects);
  const active = Object.hasOwn(projects, projectId) ? asRecord(projects[projectId]).active : undefined;
  if (!Array.isArray(active)) return [];
  return [...new Set(active.filter((id): id is string => typeof id === "string" && id !== DEFAULT_REPO))];
}

/**
 * Whether the project's `default` repository is on: `profiles.projects.<project>.default` of the user config. It is on
 * unless that is exactly `false`, so a project without an entry (every existing user) keeps it.
 */
export async function readProjectDefault(projectId: string, file: string = userConfigFile()): Promise<boolean> {
  const projects = asRecord(asRecord((await readConfig(file)).profiles).projects);
  return !(Object.hasOwn(projects, projectId) && asRecord(projects[projectId]).default === false);
}

/**
 * Turns a profile on or off for a project, keeping the rest of the config; returns the project's new list of active
 * profiles. `default` is not a list entry: turning it off writes `default: false`, turning it on removes that key.
 */
export async function setProjectProfile(projectId: string, profile: string, active: boolean, file: string = userConfigFile()): Promise<string[]> {
  const config = await readConfig(file);
  const current = await readProjectProfiles(projectId, file);
  const profiles = asRecord(config.profiles);
  const projects = asRecord(profiles.projects);
  const entry = { ...asRecord(projects[projectId]) };
  let next = current;
  if (profile === DEFAULT_REPO) {
    if (active) delete entry.default;
    else entry.default = false;
  } else {
    next = active ? [...new Set([...current, profile])] : current.filter((id) => id !== profile);
    entry.active = next;
  }
  config.profiles = { ...profiles, projects: { ...projects, [projectId]: entry } };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, stringifyYaml(config), "utf8");
  await rename(tmp, file);
  return next;
}

/** `event_core` of the user config (ADR 2026-11-12-event-core): the event log and its parity check. */
export interface EventCoreConfig {
  /** Write the per-run event log (`<run>.events.jsonl`). Off: no log file is written and no parity is checked; run state is unchanged either way. */
  log: boolean;
  /** `warn`: compare what the reducers rebuild with the state the mutators produced, log a mismatch; `off`: no check. */
  parity: "warn" | "off";
}

export const DEFAULT_EVENT_CORE: EventCoreConfig = { log: true, parity: "warn" };

/**
 * `event_core: { log: true | false, parity: warn | off }`. Anything missing or malformed falls back to the default
 * (log on, parity warn): a bad config never blocks loading. Read once when the plugin starts.
 */
export async function readEventCoreConfig(file: string = userConfigFile()): Promise<EventCoreConfig> {
  const block = asRecord((await readConfig(file)).event_core);
  return {
    log: typeof block.log === "boolean" ? block.log : DEFAULT_EVENT_CORE.log,
    parity: block.parity === "off" ? "off" : DEFAULT_EVENT_CORE.parity,
  };
}

/**
 * `quota_limits` (ADR 2026-11-23-quota-limits-in-defaults; was `rate_limits`, ADR 2026-11-20-rate-limiting, capacity reworked by ADR
 * 2026-11-20-dynamic-rate-limits): quota pacing decides how much work runs, with optional hard caps on top. Everything is off by default.
 * Set in a repository's or profile's `defaults/main.yaml` and in the user config; see `resolveQuotaLimits`.
 */
export interface RateLimitsConfig {
  /** Optional hard cap: most steps running at once across all projects; null = no cap. */
  steps: number | null;
  /** Optional hard cap: most runs admitted at once across all projects; null = no cap. */
  playbooks: number | null;
  quota: {
    /** Pace work against each provider's usage windows: start it while the headroom covers its estimated cost. */
    pacing: boolean;
    /** Percentage of a window the playbooks may use (the rest is a reserve): the hard cap, and the slope of what is allowed so far. */
    usablePercent: number;
    /** Slots of the week that do not count towards what is allowed so far (ADR 2026-11-23-quota-closed-hours); null = every hour counts. */
    closedHours?: ClosedHours | null;
    /** A reading younger than this is used as is; an older one is refreshed in the background (ms). */
    refreshMs: number;
    /** A reading older than this is unusable: new steps are held as "waiting for quota data" (ms). */
    maxAgeMs: number;
  };
}

/** What one layer (the user config, or a `defaults/main.yaml`) says: only the fields it sets. */
export interface QuotaLimitsLayer {
  steps?: number | null;
  playbooks?: number | null;
  quota?: Partial<RateLimitsConfig["quota"]>;
}

export const DEFAULT_RATE_LIMITS: RateLimitsConfig = { steps: null, playbooks: null, quota: { pacing: false, usablePercent: 97, refreshMs: 5 * 60_000, maxAgeMs: 30 * 60_000 } };

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function durationMs(value: unknown): number | undefined {
  return typeof value === "string" ? (parseDuration(value) ?? undefined) : undefined;
}

const deprecationNoted = new Set<string>();

/** Forgets which renames were noted (tests). */
export function resetDeprecationNotes(): void {
  deprecationNoted.clear();
}

/** Logs once per process that a config key was renamed; the old one keeps working. */
export function noteDeprecatedKey(oldKey: string, newKey: string): void {
  if (deprecationNoted.has(oldKey)) return;
  deprecationNoted.add(oldKey);
  console.warn(`[playbooks] \`${oldKey}\` is deprecated and still works: rename it to \`${newKey}\``);
}

let modeNoted = false;

/** `closed_hours: { timezone?, slots: [{ days, from, to }] }` as the pacing uses it; undefined when absent or malformed (the loader refuses it strictly). */
export function parseClosedHours(value: unknown): ClosedHours | null | undefined {
  if (value === undefined || value === null) return undefined;
  const block = asRecord(value);
  const timezone = typeof block.timezone === "string" && validTimezone(block.timezone) ? block.timezone : null;
  if (typeof block.timezone === "string" && timezone === null) return undefined;
  const slots: ClosedHours["slots"] = [];
  for (const entry of Array.isArray(block.slots) ? block.slots : []) {
    const slot = asRecord(entry);
    const names = typeof slot.days === "string" ? [slot.days] : Array.isArray(slot.days) ? slot.days : [];
    const days = new Set<number>();
    for (const name of names) for (const day of (typeof name === "string" ? dayNumbers(name) : null) ?? []) days.add(day);
    const fromMin = typeof slot.from === "string" ? parseClock(slot.from) : null;
    const toMin = typeof slot.to === "string" ? parseClock(slot.to) : null;
    if (days.size === 0 || fromMin === null || toMin === null || fromMin >= toMin) return undefined;
    slots.push({ days: [...days].sort((a, b) => a - b), fromMin, toMin });
  }
  return { timezone, slots };
}

/**
 * One layer of quota limits from a parsed `quota_limits` block (or the legacy `rate_limits` one: `legacy`). Anything missing or malformed
 * is left out (a bad value never blocks loading; the loader validates a defaults file strictly before it gets here).
 * `quota.pacing` is the switch: `quota_limits` also turns it on by itself when `quota.usable_percent` is set and `pacing` is not
 * (so `quota_limits: { quota: { usable_percent: 90 } }` paces at 90%); the legacy block keeps its old meaning (pacing only with `pacing: true`).
 */
export function parseQuotaLimits(value: unknown, legacy = false): QuotaLimitsLayer {
  const block = asRecord(value);
  // `mode` (step | playbook) was removed (ADR 2026-11-21-remove-rate-limit-mode): ignored, noted once.
  if ("mode" in block && !modeNoted) {
    modeNoted = true;
    console.warn("[playbooks] rate_limits.mode is no longer used and is ignored: runs are always admitted whole (remove it)");
  }
  const raw = asRecord(block.quota);
  const out: QuotaLimitsLayer = {};
  const steps = positiveInt(block.steps);
  const playbooks = positiveInt(block.playbooks);
  if (steps !== null) out.steps = steps;
  if (playbooks !== null) out.playbooks = playbooks;
  const quota: NonNullable<QuotaLimitsLayer["quota"]> = {};
  const usable = typeof raw.usable_percent === "number" && raw.usable_percent > 0 && raw.usable_percent <= 100 ? raw.usable_percent : undefined;
  if (usable !== undefined) quota.usablePercent = usable;
  const closed = parseClosedHours(raw.closed_hours);
  if (closed !== undefined) quota.closedHours = closed;
  if (typeof raw.pacing === "boolean") quota.pacing = raw.pacing;
  else if (!legacy && usable !== undefined) quota.pacing = true;
  const refresh = durationMs(raw.refresh_interval);
  const maxAge = durationMs(raw.max_age);
  if (refresh !== undefined) quota.refreshMs = refresh;
  if (maxAge !== undefined) quota.maxAgeMs = maxAge;
  if (Object.keys(quota).length > 0) out.quota = quota;
  return out;
}

/**
 * The layer a holder of config keys says, under either name: `quota_limits`, else the deprecated `rate_limits` (noted once; the new key
 * wins as a whole when both are there). `undefined` when neither is there.
 */
export function quotaLimitsLayerOf(holder: Record<string, unknown>): QuotaLimitsLayer | undefined {
  let layer: QuotaLimitsLayer | undefined;
  if (holder.quota_limits !== undefined) {
    if (holder.rate_limits !== undefined) console.warn("[playbooks] both `quota_limits` and the deprecated `rate_limits` are set: `rate_limits` is ignored");
    layer = parseQuotaLimits(holder.quota_limits);
  } else if (holder.rate_limits !== undefined) {
    noteDeprecatedKey("rate_limits", "quota_limits");
    layer = parseQuotaLimits(holder.rate_limits, true);
  }
  // The shared top-level `closed_hours` (ADR 2026-11-23-closed-hours-shared) is carried in the quota layer so the quota reads it where it
  // always did; it wins over the deprecated `quota_limits.quota.closed_hours`, which still works.
  const closed = parseClosedHours(holder.closed_hours);
  if (closed !== undefined) layer = { ...layer, quota: { ...layer?.quota, closedHours: closed } };
  else if (layer?.quota?.closedHours !== undefined) noteDeprecatedKey("quota_limits.quota.closed_hours", "closed_hours");
  return layer;
}

/** The limits in effect: the built-in defaults, then each layer in turn, a later layer overriding the fields it sets. */
export function resolveQuotaLimits(...layers: Array<QuotaLimitsLayer | null | undefined>): RateLimitsConfig {
  const out: RateLimitsConfig = { ...DEFAULT_RATE_LIMITS, quota: { ...DEFAULT_RATE_LIMITS.quota } };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.steps !== undefined) out.steps = layer.steps;
    if (layer.playbooks !== undefined) out.playbooks = layer.playbooks;
    Object.assign(out.quota, layer.quota);
  }
  out.quota.maxAgeMs = Math.max(out.quota.refreshMs, out.quota.maxAgeMs);
  return out;
}

/** `quota_limits` (or the deprecated `rate_limits`) of the user config, as a layer; read when needed, so a change applies without a reload. */
export async function readQuotaLimitsLayer(file: string = userConfigFile()): Promise<QuotaLimitsLayer> {
  return quotaLimitsLayerOf(await readConfig(file)) ?? {};
}

/** The user config's limits alone, with the built-in defaults under them. */
export async function readRateLimitsConfig(file: string = userConfigFile()): Promise<RateLimitsConfig> {
  return resolveQuotaLimits(await readQuotaLimitsLayer(file));
}

/**
 * `manager_recovery` (ADR 2026-11-23-manager-auto-recovery-and-fresh-workspaces): what the plugin does by itself when a
 * run's manager is blocked by its provider's quota. `retry` (default on) retries recovery on a timer once the provider's
 * usage shows headroom; `fallback` (default none, opt-in) is a provider/model the manager may be re-assigned to.
 */
export interface ManagerRecoveryConfig {
  retry: boolean;
  fallback: { provider: string; model: string } | null;
}

export const DEFAULT_MANAGER_RECOVERY: ManagerRecoveryConfig = { retry: true, fallback: null };

/** `manager_recovery: { retry: true, fallback: { provider, model } }` of the user config; anything malformed falls back to the default. */
export async function readManagerRecoveryConfig(file: string = userConfigFile()): Promise<Partial<ManagerRecoveryConfig>> {
  const block = asRecord((await readConfig(file)).manager_recovery);
  const fallback = asRecord(block.fallback);
  return {
    ...(typeof block.retry === "boolean" ? { retry: block.retry } : {}),
    ...(typeof fallback.provider === "string" && fallback.provider && typeof fallback.model === "string" && fallback.model ? { fallback: { provider: fallback.provider, model: fallback.model } } : {}),
  };
}
