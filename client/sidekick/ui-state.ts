import { useSyncExternalStore } from "react";
import { clampColumnWidth, COLUMN_WIDTH } from "./width";

/** The Sidekick column's UI state, kept outside the screen so it survives leaving and coming back (in-session only). */
export interface SidekickUi {
  open: boolean;
  selectedProjectId: string | null;
  /** Projects added with "+" this session. */
  added: string[];
  width: number;
  /** The unsent message of each project's tab. */
  drafts: Record<string, string>;
}

export function createSidekickUiStore() {
  let state: SidekickUi = { open: false, selectedProjectId: null, added: [], width: COLUMN_WIDTH, drafts: {} };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SidekickUi>) => {
    const next = { ...state, ...patch };
    if ((Object.keys(next) as (keyof SidekickUi)[]).every((key) => next[key] === state[key])) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setOpen: (open: boolean) => set({ open }),
    select: (selectedProjectId: string | null) => set({ selectedProjectId }),
    addProject: (projectId: string) => set({ added: state.added.includes(projectId) ? state.added : [...state.added, projectId] }),
    setWidth: (width: number) => set({ width: clampColumnWidth(width) }),
    setDraft: (projectId: string, text: string) => {
      const { [projectId]: _old, ...rest } = state.drafts;
      set({ drafts: text ? { ...rest, [projectId]: text } : rest });
    },
  };
}

/** The selected tab when it still exists, else the first tab (or null). */
export function resolveSelected(selected: string | null, tabIds: string[]): string | null {
  return selected !== null && tabIds.includes(selected) ? selected : (tabIds[0] ?? null);
}

export const sidekickUi = createSidekickUiStore();

export function useSidekickUi(): SidekickUi {
  return useSyncExternalStore(sidekickUi.subscribe, sidekickUi.get, sidekickUi.get);
}
