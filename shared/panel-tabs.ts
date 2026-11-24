/** The main panel's top tab bar (ADR 2026-11-23-addable-panel-tabs): Runs is fixed, every other tab is added with "+" and closed with its x. */
export const PANEL_TABS = ["runs", "analytics", "quota", "offHours", "profiles"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** The default tab: always shown, never closed. */
export const FIXED_TAB: PanelTab = "runs";

/** The tabs a user can add, in bar order. */
export const ADDABLE_TABS: readonly PanelTab[] = PANEL_TABS.filter((tab) => tab !== FIXED_TAB);

export const isPanelTab = (value: unknown): value is PanelTab => typeof value === "string" && (PANEL_TABS as readonly string[]).includes(value);

/** What is stored: only known, addable tabs, once each, in bar order. Anything else (a tab removed in a later version, junk) is dropped. */
export function normalizeOpenTabs(stored: readonly unknown[] | null | undefined): PanelTab[] {
  const set = new Set(stored ?? []);
  return ADDABLE_TABS.filter((tab) => set.has(tab));
}

/** The tabs shown, Runs first, then the added ones in bar order. */
export const visibleTabs = (open: readonly PanelTab[]): PanelTab[] => [FIXED_TAB, ...normalizeOpenTabs(open)];

/** The tabs the "+" menu lists; empty means no "+" button. */
export const closedTabs = (open: readonly PanelTab[]): PanelTab[] => ADDABLE_TABS.filter((tab) => !open.includes(tab));

export interface TabsState {
  open: PanelTab[];
  selected: PanelTab;
}

/** Opens a tab and selects it. Also the entry point of any link that selects a tab: a hidden one opens instead of showing nothing. */
export function openTab(state: TabsState, tab: PanelTab): TabsState {
  if (tab === FIXED_TAB) return { ...state, selected: FIXED_TAB };
  return { open: normalizeOpenTabs([...state.open, tab]), selected: tab };
}

/** Closes an added tab. Closing the selected one falls back to Runs; Runs cannot be closed. */
export function closeTab(state: TabsState, tab: PanelTab): TabsState {
  if (tab === FIXED_TAB) return state;
  return { open: state.open.filter((candidate) => candidate !== tab), selected: state.selected === tab ? FIXED_TAB : state.selected };
}

/** What the "+" menu does with an item: shows a hidden tab (without selecting it) or hides a shown one. Runs and the selected tab cannot be hidden, so they come back unchanged. */
export function toggleTab(state: TabsState, tab: PanelTab): TabsState {
  if (tab === FIXED_TAB || tab === state.selected) return state;
  const open = state.open.includes(tab) ? state.open.filter((candidate) => candidate !== tab) : normalizeOpenTabs([...state.open, tab]);
  return { ...state, open };
}

/** Whether the "+" menu lets a tab be toggled: not Runs, not the tab being shown. */
export const canToggleTab = (state: TabsState, tab: PanelTab): boolean => tab !== FIXED_TAB && tab !== state.selected;

/** The tab to render: a selected tab that is not open (a stale selection) shows Runs. */
export const effectiveTab = (state: TabsState): PanelTab => (state.selected === FIXED_TAB || state.open.includes(state.selected) ? state.selected : FIXED_TAB);
