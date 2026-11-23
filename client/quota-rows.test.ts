import { describe, expect, it } from "vitest";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { barOf, projectRows } from "./quota-rows";

const slot = (over: Partial<QuotaLimitation["providers"][number]["windows"][number]> = {}) => ({ id: "weekly", name: "Weekly", modelScoped: false, used: 38, reserved: 5, paces: [{ usable: 90, ceiling: 60, headroom: 22, free: 17, projects: ["App"] }], resetsAt: null, stale: false, ...over });
const provider = (windows = [slot()], over: Partial<QuotaLimitation["providers"][number]> = {}): QuotaLimitation["providers"][number] => ({ provider: "claude", pacedBy: ["App"], state: "ok", readAt: null, overrideUntil: null, windows, reservations: [], held: [], exhausted: [], ...over });
const limits = (over = {}) => ({ repos: ["default"], pacing: true, usablePercent: 90, stepsLimit: null, runsLimit: null, ...over });
const data = (providers = [provider()], projects = [{ projectId: "p", label: "App", limits: [limits()] }]): QuotaLimitation => ({ now: "2026-11-23T00:00:00Z", projects, stepsRunning: 0, runsActive: 0, providers, limitHeld: [] });

describe("quota bar", () => {
  it("is grey to the usage, green for the free room after the reservations, a tick at the ceiling", () => {
    expect(barOf(38, 60, 17, 5)).toEqual({ grey: 38, greenFrom: 43, green: 17, redFrom: 60, red: 0, tick: 60 });
  });
  it("turns the usage above the ceiling red, with no green", () => {
    expect(barOf(65, 60, -5, 0)).toEqual({ grey: 60, greenFrom: 65, green: 0, redFrom: 60, red: 5, tick: 60 });
  });
  it("is a plain grey bar without a ceiling", () => {
    expect(barOf(38, null, null, 0)).toEqual({ grey: 38, greenFrom: 0, green: 0, redFrom: 0, red: 0, tick: null });
  });
});

describe("quota project rows", () => {
  it("takes the pace of the project's own percent and summarises the free room", () => {
    const [row] = projectRows(data());
    expect(row).toMatchObject({ tone: "ok", pacing: true, percents: [90], summary: [{ provider: "claude", status: "ok", free: 17 }] });
    expect(row!.sets[0]!.providers[0]!.slots[0]).toMatchObject({ paced: true, ceiling: 60, free: 17, over: 0 });
  });

  it("flags usage above the ceiling as over", () => {
    const [row] = projectRows(data([provider([slot({ used: 65, paces: [{ usable: 90, ceiling: 60, headroom: -5, free: -5, projects: ["App"] }] })])]));
    expect(row!.tone).toBe("over");
    expect(row!.sets[0]!.providers[0]!.slots[0]!.over).toBe(5);
  });

  it("does not pace a project with pacing off, nor a model window", () => {
    const [off] = projectRows(data(undefined, [{ projectId: "p", label: "App", limits: [limits({ pacing: false })] }]));
    expect(off).toMatchObject({ tone: "off", pacing: false, summary: [] });
    expect(off!.sets[0]!.providers[0]!.slots[0]).toMatchObject({ paced: false, ceiling: null, bar: { tick: null, green: 0, red: 0 } });
    const [model] = projectRows(data([provider([slot({ modelScoped: true })])]));
    expect(model!.sets[0]!.providers[0]!.slots[0]!.paced).toBe(false);
  });

  it("ignores the pace figure of another project's percent", () => {
    const [row] = projectRows(data([provider([slot({ paces: [{ usable: 50, ceiling: 30, headroom: -8, free: -8, projects: ["Other"] }] })])]));
    expect(row!.sets[0]!.providers[0]!.slots[0]!.paced).toBe(false);
  });

  it("warns when the usage is unavailable and lists only the project's own runs", () => {
    const mine = { runId: "a", title: "A", projectId: "p", kind: "pace", reason: "r", window: null, retryAt: null };
    const other = { ...mine, runId: "b", projectId: "q" };
    const [row] = projectRows(data([provider([slot()], { state: "unavailable", held: [mine, other] })]));
    expect(row!.tone).toBe("warn");
    expect(row!.sets[0]!.providers[0]!.held.map((run) => run.runId)).toEqual(["a"]);
  });
});
