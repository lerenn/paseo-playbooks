/**
 * Provider usage (`providers.usage`): the daemon reports, per provider, how much of each usage window
 * (5-hour, weekly, per-model weekly...) is used. A target whose provider is at the threshold is skipped
 * before a step starts on it, instead of after a failed turn. Usage only improves the ordering: when it
 * cannot be read, every target stays usable and the failure-based fail-over remains the safety net.
 */

/** One usage window of a provider, as the daemon reports it (only the fields read here). */
export interface UsageWindow {
  id: string;
  label?: string;
  usedPct?: number | null;
  remainingPct?: number | null;
  /** ISO time the window resets. */
  resetsAt?: string | null;
}

export interface ProviderUsage {
  providerId: string;
  status?: string;
  windows?: UsageWindow[];
}

export interface UsageSnapshot {
  providers: ProviderUsage[];
  /** ISO time the daemon refreshes its own cache, when it says. */
  nextRefreshAt?: string | null;
}

/** A window that keeps a target from being used. */
export interface UsageBlock {
  window: string;
  usedPct: number;
  /** ISO reset time of the window, null when the daemon gave none. */
  resetsAt: string | null;
}

/** How long a read is reused (also bounded by the daemon's `nextRefreshAt`), and a failed read. */
export const USAGE_MEMO_MS = 45_000;
export const USAGE_ERROR_MEMO_MS = 15_000;
const MIN_MEMO_MS = 5_000;

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The model a window is about, or null for a provider-wide window. Only an id of the form
 * `<anything>_model_<name>` (`weekly_model_fable`) names a model.
 */
export function windowModel(id: string): string | null {
  const match = /(?:^|[_\-.:])model[_\-.:](.+)$/i.exec(id);
  return match ? normalize(match[1]!) : null;
}

/** Whether a window applies to `model`: provider-wide windows always do; a model window only when its name is part of the model id (either way round). */
export function windowAppliesTo(id: string, model: string | undefined): boolean {
  const named = windowModel(id);
  if (!named) return true;
  if (!model) return false;
  const target = normalize(model);
  return target.includes(named) || named.includes(target);
}

/**
 * The window that keeps `provider/model` out of use at `threshold` percent, or null when it is usable:
 * no entry, status not `available`, no windows, nothing at the threshold, a window of another model, or a
 * window whose reset time has passed (the daemon's cache is stale). The fullest blocking window wins.
 */
export function usageBlock(snapshot: UsageSnapshot | null, provider: string, model: string | undefined, threshold: number, nowMs: number = Date.now()): UsageBlock | null {
  const entry = snapshot?.providers.find((candidate) => candidate.providerId === provider);
  if (!entry || (entry.status !== undefined && entry.status !== "available")) return null;
  let found: UsageBlock | null = null;
  for (const window of entry.windows ?? []) {
    if (!windowAppliesTo(window.id, model)) continue;
    const used = window.usedPct ?? (window.remainingPct !== undefined && window.remainingPct !== null ? 100 - window.remainingPct : null);
    if (used === null) continue;
    const full = used >= threshold || (window.remainingPct !== undefined && window.remainingPct !== null && window.remainingPct <= 0);
    if (!full) continue;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(reset) && reset <= nowMs) continue;
    if (!found || used > found.usedPct) found = { window: window.id, usedPct: used, resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
  }
  return found;
}

/** Host-wide usage read: one shared in-flight call, reused for a short while. Never forces the daemon to refresh. */
export class UsageCache {
  private memo: { snapshot: UsageSnapshot | null; until: number } | null = null;
  private inflight: Promise<UsageSnapshot | null> | null = null;

  constructor(private readonly fetch: () => Promise<UsageSnapshot>) {}

  /** The usage of every provider, or null when it could not be read. */
  async read(): Promise<UsageSnapshot | null> {
    if (this.memo && this.memo.until > Date.now()) return this.memo.snapshot;
    this.inflight ??= this.load().finally(() => void (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<UsageSnapshot | null> {
    const now = Date.now();
    try {
      const snapshot = await this.fetch();
      const refresh = snapshot.nextRefreshAt ? Date.parse(snapshot.nextRefreshAt) : NaN;
      const until = now + (Number.isFinite(refresh) ? Math.min(USAGE_MEMO_MS, Math.max(MIN_MEMO_MS, refresh - now)) : USAGE_MEMO_MS);
      this.memo = { snapshot, until };
      return snapshot;
    } catch {
      this.memo = { snapshot: null, until: now + USAGE_ERROR_MEMO_MS };
      return null;
    }
  }
}
