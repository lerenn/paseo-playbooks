import { useSyncExternalStore } from "react";
import type { OverviewStore } from "./overview-store";
import { indexBadges, type WorkspaceBadges } from "./workspace-badges";

export type BadgeIndex = ReadonlyMap<string, WorkspaceBadges>;

/**
 * The badges of every workspace row, from one shared index. The host mounts each badge Component
 * once per workspace row, so a row must not fetch: all rows read this store, which rides on the
 * overview store (one agent subscription, one request per change, with a 60 s fallback) and
 * rebuilds the index once per new set of runs, not once per row.
 */
export interface BadgeStore {
  subscribe(listener: () => void): () => void;
  /** The same object until the runs change. */
  get(): BadgeIndex;
}

const EMPTY: BadgeIndex = new Map();

export function createBadgeStore(overview: OverviewStore, now: () => number = Date.now): BadgeStore {
  const listeners = new Set<() => void>();
  let source: unknown = null;
  let index: BadgeIndex = EMPTY;
  let release: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const get = () => {
    const { runs } = overview.get();
    if (runs !== source) {
      source = runs;
      index = runs ? indexBadges(runs, now()) : EMPTY;
    }
    return index;
  };

  return {
    get,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // The first row asks the overview store for the runs, once for all rows.
        unsubscribe = overview.subscribe(() => {
          for (const each of listeners) each();
        });
        release = overview.watchRuns();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        release?.();
        unsubscribe?.();
        release = null;
        unsubscribe = null;
      };
    },
  };
}

export function useWorkspaceBadges(store: BadgeStore, workspaceId: string): WorkspaceBadges | null {
  return useSyncExternalStore(store.subscribe, store.get).get(workspaceId) ?? null;
}
