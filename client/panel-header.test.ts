import { describe, expect, it } from "vitest";
import { PANEL_TABS } from "../shared/panel-tabs";
import { HEADER, SUMMARY_LINE, TABS, TAB_ICONS, headerGeometry, headerPad, summaryTop, tabParts } from "./panel-header";

describe("panel header and tabs", () => {
  it("has an icon for every tab, all different", () => {
    for (const tab of PANEL_TABS) expect(TAB_ICONS[tab]).toBeTruthy();
    expect(new Set(PANEL_TABS.map((tab) => TAB_ICONS[tab])).size).toBe(PANEL_TABS.length);
  });
  it("keeps every label on a wide layout", () => {
    expect(tabParts({ compact: false, selected: false }).label).toBe(true);
  });
  it("keeps only the selected label on a compact layout", () => {
    expect(tabParts({ compact: true, selected: true }).label).toBe(true);
    expect(tabParts({ compact: true, selected: false }).label).toBe(false);
  });
  // Reference: paseo-kubernetes-workspaces plugin/client/screen.tsx: pad 16/28 (l.234), tile 44 (l.252),
  // gap 14 (l.249, l.244), tab padding 10/14 and underline 2 (l.302-304), divider 1 (l.245).
  it("puts the tile and the tabs where the Kubernetes workspaces page has them", () => {
    const wide = headerGeometry({ compact: false, rowHeight: 44, tabHeight: 39 });
    expect(wide.tileLeft).toBe(28);
    expect(wide.tileTop).toBe(28);
    expect(wide.titleLeft).toBe(28 + 44 + 14);
    expect(wide.tabsTop).toBe(28 + 44 + 14);
    expect(wide.firstIconLeft).toBe(28 + 14);
    expect(wide.dividerTop).toBe(wide.tabsTop + 39);
    const compact = headerGeometry({ compact: true, rowHeight: 44, tabHeight: 39 });
    expect([compact.tileLeft, compact.tileTop]).toEqual([16, 16]);
  });
  it("centres the tile in a taller row, like the reference", () => {
    expect(headerGeometry({ compact: false, rowHeight: 48, tabHeight: 39 }).tileTop).toBe(30);
  });
  it("aligns the content with the header", () => {
    expect(headerPad(false)).toBe(28);
    expect(headerPad(true)).toBe(16);
  });
  it("uses the reference tab constants", () => {
    expect([TABS.padY, TABS.padX, TABS.underline, TABS.divider, TABS.gap, TABS.icon, TABS.iconGap, TABS.labelSize]).toEqual([10, 14, 2, 1, 4, 15, 7, 14]);
    expect([HEADER.tile, HEADER.tileRadius, HEADER.titleSizeWide, HEADER.titleSizeCompact, HEADER.taglineSize, HEADER.textGap]).toEqual([44, 12, 24, 20, 13, 2]);
  });
  it("fits the summary group in the gap above the tab row without moving the tabs", () => {
    for (const compact of [false, true]) {
      const g = headerGeometry({ compact, rowHeight: 44, tabHeight: 39 });
      expect(summaryTop(compact) + SUMMARY_LINE).toBe(g.tabsTop);
      expect(summaryTop(compact)).toBeGreaterThan(headerPad(compact) + 44 - 6);
    }
  });
});
