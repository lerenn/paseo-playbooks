import { useEffect, useSyncExternalStore } from "react";
import { createLeadRegistry, type BadgeItemId, type LeadRegistry } from "./badge-lead";
import type { BadgeIndex, OverviewStore } from "./overview-store";
import type { WorkspaceBadges } from "../shared/workspace-badges";

/**
 * The badges of every workspace row, from one shared index. The host mounts each badge Component
 * once per workspace row. The overview store fetches and indexes their badges together.
 */
export interface BadgeStore {
  subscribe(listener: () => void): () => void;
  /** The same object until the badge data refreshes. */
  get(): BadgeIndex;
  /** Which badges render on each row, for the leading separator. */
  lead: LeadRegistry;
}

const EMPTY: BadgeIndex = new Map();

export function createBadgeStore(overview: OverviewStore): BadgeStore {
  const listeners = new Set<() => void>();
  let release: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    get: () => overview.get().badges ?? EMPTY,
    lead: createLeadRegistry(),
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        release = overview.watchBadges();
        unsubscribe = overview.subscribe(() => {
          for (const each of listeners) each();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribe?.();
        release?.();
        release = null;
        unsubscribe = null;
      };
    },
  };
}

export function useWorkspaceBadges(store: BadgeStore, workspaceId: string): WorkspaceBadges | null {
  return useSyncExternalStore(store.subscribe, store.get).get(workspaceId) ?? null;
}

/** Whether this badge, rendering or not, is the one that carries its row's leading "·": the first of ours that renders. */
export function useLeadingDot(store: BadgeStore, workspaceId: string, id: BadgeItemId, renders: boolean): boolean {
  useEffect(() => (renders ? store.lead.register(workspaceId, id) : undefined), [store, workspaceId, id, renders]);
  return useSyncExternalStore(store.lead.subscribe, () => store.lead.lead(workspaceId)) === id;
}
