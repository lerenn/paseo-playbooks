import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { needsYouRpc, overviewBadgesRpc, overviewStateRpc } from "../shared/contracts";
import { needsReview } from "../shared/gates";
import type { RunSummary } from "../shared/types";
import { indexBadges, type WorkspaceBadges } from "../shared/workspace-badges";
import { watchAgents } from "./events";
import { isHidden, onVisible } from "./visibility";

/** Agent events across every workspace are batched over this long before one refresh. */
const EVENTS_BATCH_MS = 1_000;
/** Fallback refresh, for changes with no agent activity (a step timeout firing on the daemon). */
const FALLBACK_MS = 60_000;

export type BadgeIndex = ReadonlyMap<string, WorkspaceBadges>;

export interface OverviewSnapshot {
  /** Gates waiting for a human on this host: the sidebar badge. */
  count: number;
  /** Runs not archived, while a Playbooks screen is open; null before the first load or when none is. */
  runs: RunSummary[] | null;
  /** Workspace badges while sidebar rows are mounted. */
  badges: BadgeIndex | null;
  error: string | null;
}

/** One agent subscription and refresh loop for the sidebar count, workspace badges and Playbooks screen. */
export interface OverviewStore {
  subscribe(listener: () => void): () => void;
  get(): OverviewSnapshot;
  /** A screen is open until the returned function is called: runs are fetched meanwhile. */
  watchRuns(): () => void;
  /** Request workspace badge data while the sidebar has mounted rows. */
  watchBadges(): () => void;
  /** Refresh now (after an action of the user), merged with one already in flight. */
  refresh(): void;
}

export function createOverviewStore(client: PluginClientContext): OverviewStore & { dispose(): void } {
  let snapshot: OverviewSnapshot = { count: 0, runs: null, badges: null, error: null };
  const listeners = new Set<() => void>();
  let screens = 0;
  let badgeWatchers = 0;
  let inFlight = false;
  let again = false;
  /** A refresh was skipped while the page was in the background; the page shows again, it runs. */
  let missed = false;
  let stop: (() => void) | null = null;

  const set = (next: Partial<OverviewSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const refresh = () => {
    if (!stop) return;
    // A background tab still receives every agent event; it refreshes once when it shows again.
    if (isHidden()) {
      missed = true;
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const withRuns = screens > 0;
    const request: Promise<Partial<OverviewSnapshot>> = withRuns
      ? client.rpc(overviewStateRpc, {}).then(({ runs }) => ({
          runs,
          count: runs.reduce((count, run) => count + run.gates.filter(needsReview).length, 0),
          badges: badgeWatchers > 0 ? indexBadges(runs, Date.now()) : null,
        }))
      : badgeWatchers > 0
        ? client.rpc(overviewBadgesRpc, {}).then(({ count, badges }) => ({ count, badges: new Map(badges) }))
        : client.rpc(needsYouRpc, {});
    void request
      .then((result) => {
        if (!stop) return;
        set({
          ...result,
          ...(screens === 0 ? { runs: null } : {}),
          ...(badgeWatchers === 0 ? { badges: null } : {}),
          error: null,
        });
      })
      .catch((error: unknown) => {
        console.error("[playbooks] overview refresh failed", error);
        if (stop) set({ error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          refresh();
        }
      });
  };

  /** Runs while something shows the store: the agent subscription and the fallback timer. */
  const start = () => {
    const unwatch = watchAgents(client.paseo, null, refresh, EVENTS_BATCH_MS);
    const timer = setInterval(refresh, FALLBACK_MS);
    const unwatchVisible = onVisible(() => {
      if (!missed) return;
      missed = false;
      refresh();
    });
    stop = () => {
      unwatch();
      clearInterval(timer);
      unwatchVisible();
    };
    refresh();
  };
  const halt = () => {
    stop?.();
    stop = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) halt();
      };
    },
    get: () => snapshot,
    watchRuns() {
      screens += 1;
      refresh();
      return () => {
        screens -= 1;
        if (screens === 0) set({ runs: null });
      };
    },
    watchBadges() {
      badgeWatchers += 1;
      if (badgeWatchers === 1) refresh();
      return () => {
        badgeWatchers -= 1;
        if (badgeWatchers === 0) set({ badges: null });
      };
    },
    refresh,
    dispose: halt,
  };
}

export function useOverview(store: OverviewStore): OverviewSnapshot {
  return useSyncExternalStore(store.subscribe, store.get);
}
