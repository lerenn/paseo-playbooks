import type { PanelTab } from "../shared/panel-tabs";

/**
 * Dimensions (CSS px) of the Playbooks screen's header and tab bar. They are measured on another
 * plugin's page (screenshot at 2x, halved) so that switching pages keeps the tile and the title
 * where they were: tune them here, in one place.
 */
export const HEADER = {
  /** Left edge of the tile, of the tab row and of the first underline. */
  padLeft: 16,
  /** Right edge of the buttons. */
  padRight: 16,
  /** Top of the tile. */
  padTop: 25,
  tile: 44,
  tileRadius: 10,
  /** Tile to title. */
  tileGap: 15,
  titleSize: 22,
  titleLine: 26,
  taglineSize: 16,
  taglineLine: 20,
  /** Bottom of the tile to the top of the tab row. */
  tabsTop: 11,
} as const;

export const TABS = {
  /** Height of a tab, its underline included: the 1 px divider sits at its bottom edge. */
  height: 44,
  underline: 3,
  /** Left and right of a tab's content, inside its underline. */
  padX: 14,
  /** Between two tabs: with the paddings, 32 px from one label to the next icon. */
  gap: 4,
  icon: 16,
  /** Icon to label. */
  iconGap: 7,
  labelSize: 14,
} as const;

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
