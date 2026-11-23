import { describe, expect, it } from "vitest";
import { overviewSettings } from "./overview-settings";
import { closedTabs, closeTab, effectiveTab, normalizeOpenTabs, openTab, visibleTabs, type TabsState } from "./panel-tabs";

const start: TabsState = { open: [], selected: "runs" };

describe("panel tabs", () => {
  it("starts with Runs only", () => {
    expect(visibleTabs([])).toEqual(["runs"]);
    expect(closedTabs([])).toEqual(["analytics", "quota", "offHours", "profiles"]);
  });

  it("opens a tab and selects it; opening twice does not duplicate", () => {
    const once = openTab(start, "quota");
    expect(once).toEqual({ open: ["quota"], selected: "quota" });
    expect(openTab(once, "quota").open).toEqual(["quota"]);
  });

  it("keeps added tabs in bar order whatever the order of adding", () => {
    const state = openTab(openTab(start, "profiles"), "analytics");
    expect(visibleTabs(state.open)).toEqual(["runs", "analytics", "profiles"]);
  });

  it("selecting Runs never adds it", () => {
    expect(openTab({ open: ["quota"], selected: "quota" }, "runs")).toEqual({ open: ["quota"], selected: "runs" });
  });

  it("closing the selected tab falls back to Runs, closing another keeps the selection", () => {
    const state: TabsState = { open: ["analytics", "quota"], selected: "quota" };
    expect(closeTab(state, "quota")).toEqual({ open: ["analytics"], selected: "runs" });
    expect(closeTab(state, "analytics")).toEqual({ open: ["quota"], selected: "quota" });
  });

  it("Runs cannot be closed", () => {
    expect(closeTab(start, "runs")).toBe(start);
  });

  it("lists no closed tab once all are open (no + button)", () => {
    const all = normalizeOpenTabs(["analytics", "quota", "offHours", "profiles"]);
    expect(closedTabs(all)).toEqual([]);
  });

  it("drops unknown, duplicate and fixed entries from what is stored", () => {
    expect(normalizeOpenTabs(["bogus", "quota", "quota", "runs", 3])).toEqual(["quota"]);
    expect(normalizeOpenTabs(undefined)).toEqual([]);
  });

  it("shows Runs for a selection that is not open", () => {
    expect(effectiveTab({ open: [], selected: "quota" })).toBe("runs");
    expect(effectiveTab({ open: ["quota"], selected: "quota" })).toBe("quota");
  });

  it("persists: a store from before this setting loads with no added tab; a saved list round-trips", () => {
    expect(overviewSettings.schema.parse({ sort: "activity" }).openTabs).toEqual([]);
    expect(overviewSettings.schema.parse({ openTabs: ["quota"] }).openTabs).toEqual(["quota"]);
  });
});
