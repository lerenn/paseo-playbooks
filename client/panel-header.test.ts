import { describe, expect, it } from "vitest";
import { PANEL_TABS } from "../shared/panel-tabs";
import { HEADER, TABS, TAB_ICONS, tabParts } from "./panel-header";

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
  it("matches the measured geometry: tile bottom to divider", () => {
    expect(HEADER.padTop + HEADER.tile + HEADER.tabsTop + TABS.height).toBe(124);
  });
});
