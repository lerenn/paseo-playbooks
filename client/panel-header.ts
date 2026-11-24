import type { PanelTab } from "../shared/panel-tabs";

/**
 * Dimensions (CSS px) of the Playbooks screen's header and tab bar. They are the constants of the
 * Kubernetes workspaces plugin's page (plugin/client/screen.tsx, lines 234-331) and the container
 * structure is the same (the header is the first child of the screen, no wrapper padding), so
 * switching pages keeps the tile and the title where they were. Left unset on purpose, like there:
 * the line heights (the platform's default).
 */
export const HEADER = {
  /** Left, right and top padding of the header: 16 on a compact layout, 28 otherwise (screen.tsx:234). */
  padCompact: 16,
  padWide: 28,
  tile: 44,
  tileRadius: 12,
  /** Tile to title (screen.tsx:249). */
  tileGap: 14,
  titleSizeCompact: 20,
  titleSizeWide: 24,
  taglineSize: 13,
  /** Title to tagline (screen.tsx:266). */
  textGap: 2,
  /** Title row to tab row (screen.tsx:244). */
  rowGap: 14,
} as const;

export const TABS = {
  /** Thickness of the selected tab's underline; the 1 px divider sits right below the tabs. */
  underline: 2,
  divider: 1,
  /** Top and bottom of a tab's content, inside its underline. */
  padY: 10,
  /** Left and right of a tab's content, inside its underline. */
  padX: 14,
  /** Between two tabs. */
  gap: 4,
  icon: 15,
  /** Icon to label. */
  iconGap: 7,
  labelSize: 14,
} as const;

/** The header's left, right and top padding, which is also the screen content's padding. */
export function headerPad(compact: boolean): number {
  return compact ? HEADER.padCompact : HEADER.padWide;
}

/** Offsets from the top-left corner of the screen, where the header starts, for a row at least as tall as the tile. */
export function headerGeometry(input: { compact: boolean; rowHeight: number; tabHeight: number }) {
  const pad = headerPad(input.compact);
  const rowHeight = Math.max(input.rowHeight, HEADER.tile);
  const tabsTop = pad + rowHeight + HEADER.rowGap;
  return {
    tileLeft: pad,
    tileTop: pad + (rowHeight - HEADER.tile) / 2,
    titleLeft: pad + HEADER.tile + HEADER.tileGap,
    tabsTop,
    firstTabLeft: pad,
    firstIconLeft: pad + TABS.padX,
    dividerTop: tabsTop + input.tabHeight,
  };
}

/** Height of the summary line that sits in the gap between the header buttons and the tab row (wide layout). */
export const SUMMARY_LINE = 17;

/** Top of the summary group: it ends where the tab row starts, so it adds no height and moves nothing. */
export function summaryTop(compact: boolean): number {
  return headerPad(compact) + HEADER.tile + HEADER.rowGap - SUMMARY_LINE;
}

/** The icon of each tab (Lucide names of the host's icon set). */
export const TAB_ICONS: Record<PanelTab, string> = {
  runs: "ListChecks",
  analytics: "BarChart3",
  quota: "Gauge",
  offHours: "Moon",
  profiles: "Layers",
};

/** What a tab shows: its label when selected or when there is room; on a compact layout an unselected tab is its icon alone. */
export function tabParts(input: { compact: boolean; selected: boolean }): { label: boolean } {
  return { label: input.selected || !input.compact };
}
