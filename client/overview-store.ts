import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { needsYouRpc, overviewStateRpc } from "../shared/contracts";
import { waitsForHuman } from "../shared/gates";
import type { RunSummary } from "../shared/types";
import { watchAgents } from "./events";

/** Agent events across every workspace are batched over this long before one refresh. */
const EVENTS_BATCH_MS = 1_000;
/** Fallback refresh, for changes with no agent activity (a step timeout firing on the daemon). */
const FALLBACK_MS = 60_000;

export interface OverviewSnapshot {
  /** Gates waiting for a human on this host: the sidebar badge. */
  count: number;
  /** Runs not archived, while a Playbooks screen is open; null before the first load or when none is. */
  runs: RunSummary[] | null;
  error: string | null;
}

/**
 * What the sidebar badge and the Playbooks screen show, kept by one agent subscription and one
 * request per change for both. With no screen open it only fetches the count; while one is open
 * it fetches the runs and counts their pending gates.
 */
export interface OverviewStore {
  subscribe(listener: () => void): () => void;
  get(): OverviewSnapshot;
  /** A screen is open until the returned function is called: runs are fetched meanwhile. */
  watchRuns(): () => void;
  /** Refresh now (after an action of the user), merged with one already in flight. */
  refresh(): void;
}

export function createOverviewStore(client: PluginClientContext): OverviewStore & { dispose(): void } {
  let snapshot: OverviewSnapshot = { count: 0, runs: null, error: null };
  const listeners = new Set<() => void>();
  let screens = 0;
  let inFlight = false;
  let again = false;
  let stop: (() => void) | null = null;

  const set = (next: Partial<OverviewSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const refresh = () => {
    if (!stop) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const withRuns = screens > 0;
    const request = withRuns
      ? client.rpc(overviewStateRpc, {}).then(({ runs }) => ({
          runs,
          count: runs.reduce((count, run) => count + run.gates.filter(waitsForHuman).length, 0),
        }))
      : client.rpc(needsYouRpc, {}).then(({ count }) => ({ count }));
    void request
      .then((result) => {
        // A screen that closed meanwhile does not get its runs back.
        if (stop) set({ ...result, ...(withRuns && screens === 0 ? { runs: null } : {}), error: null });
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
    stop = () => {
      unwatch();
      clearInterval(timer);
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
    refresh,
    dispose: halt,
  };
}

export function useOverview(store: OverviewStore): OverviewSnapshot {
  return useSyncExternalStore(store.subscribe, store.get);
}
