import { describe, expect, it } from "vitest";
import type { QuotaLimitation, QuotaProvider } from "../shared/quota-limitation";
import { barOf, formatWait, projectRows, throttleOf, unavailableProviders } from "./quota-rows";

const slot = (over: Partial<QuotaLimitation["providers"][number]["windows"][number]> = {}) => ({ id: "weekly", name: "Weekly", modelScoped: false, used: 38, reserved: 5, paces: [{ usable: 90, ceiling: 60, headroom: 22, free: 17, projects: ["App"] }], resetsAt: null, stale: false, ...over });
const provider = (windows = [slot()], over: Partial<QuotaLimitation["providers"][number]> = {}): QuotaLimitation["providers"][number] => ({ provider: "claude", pacedBy: ["App"], state: "ok", readAt: null, overrideUntil: null, windows, reservations: [], held: [], exhausted: [], ...over });
const limits = (over = {}) => ({ repos: ["default"], pacing: true, usablePercent: 90, stepsLimit: null, runsLimit: null, ...over });
const data = (providers = [provider()], projects: QuotaLimitation["projects"] = [{ projectId: "p", label: "App", limits: [limits()] }]): QuotaLimitation => ({ now: "2026-11-23T00:00:00Z", projects, stepsRunning: 0, runsActive: 0, providers, limitHeld: [] });

describe("quota bar", () => {
  it("is grey to the usage, green for the free room after the reservations, a tick at the ceiling", () => {
    expect(barOf(38, 60, 17, 5)).toEqual({ grey: 38, greenFrom: 43, green: 17, redFrom: 60, red: 0, tick: 60 });
  });
  it("turns the usage above the ceiling into the over part, with no green", () => {
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

  it("warns when the usage is unavailable and lists only the project's own runs, a held run among the reservations with a tag", () => {
    const mine = { runId: "a", title: "A", projectId: "p", kind: "pace", reason: "r", window: null, retryAt: null };
    const other = { ...mine, runId: "b", projectId: "q" };
    const [row] = projectRows(data([provider([slot()], { state: "unavailable", held: [mine, other] })]));
    expect(row!.tone).toBe("warn");
    expect(row!.sets[0]!.providers[0]!.reservations.map((run) => [run.runId, run.hold, run.remaining])).toEqual([["a", "paused", {}]]);
    // A run that reserves and is held keeps its reservation, tagged "held" for a hold that is not the pace.
    const reserving = { runId: "a", title: "A", projectId: "p", remaining: { weekly: 3 } };
    const [again] = projectRows(data([provider([slot()], { reservations: [reserving, { ...reserving, runId: "c" }], held: [{ ...mine, kind: "headroom" }] })]));
    expect(again!.sets[0]!.providers[0]!.reservations.map((run) => [run.runId, run.hold, run.remaining])).toEqual([["a", "held", { weekly: 3 }], ["c", null, { weekly: 3 }]]);
  });
});

describe("quota throttle", () => {
  const reserving = (runId: string, weekly: number) => ({ runId, title: runId, projectId: "p", remaining: { weekly } });
  const held = (runId: string, over = {}) => ({ runId, title: runId, projectId: "p", kind: "headroom", reason: "r", window: "weekly", retryAt: null, since: "2026-11-22T22:00:00Z", estimatedCost: null, ...over });
  const throttle = (providers: QuotaLimitation["providers"], projects?: Parameters<typeof data>[1]) => projectRows(data(providers, projects))[0]!.sets[0]!.providers[0]!.throttle;

  it("does not count an exempt run in the typical need, or as held or paused", () => {
    const exempt = { ...reserving("e", 90), exempt: true };
    const out = throttle([provider([slot()], { reservations: [reserving("a", 20), reserving("b", 48), exempt] })]);
    // As without the exempt run: free 17, median need 34.
    expect(out).toMatchObject({ percent: 50, held: 0, paused: 0 });
    const [row] = projectRows(data([provider([slot()], { reservations: [exempt] })]));
    expect(row!.sets[0]!.providers[0]!.reservations).toMatchObject([{ runId: "e", exempt: true, hold: null }]);
  });

  it("is 0% when the free headroom covers the median need, and falls with it", () => {
    expect(throttle([provider([slot()], { reservations: [reserving("a", 5), reserving("b", 10), reserving("c", 40)] })]).percent).toBe(0);
    // free 17, median need 34 (of 20 and 48): 1 - 17/34 = 50%
    expect(throttle([provider([slot()], { reservations: [reserving("a", 20), reserving("b", 48)] })])).toMatchObject({ percent: 50, source: "runs" });
  });

  it("is 100% when the usage is over the ceiling or nothing is free", () => {
    const over = slot({ used: 65, paces: [{ usable: 90, ceiling: 60, headroom: -5, free: -5, projects: ["App"] }] });
    expect(throttle([provider([over], { reservations: [reserving("a", 5)] })]).percent).toBe(100);
    expect(projectRows(data([provider([over], { reservations: [reserving("a", 5)] })]))[0]!.throttled).toBe(true);
  });

  it("counts a held run with its estimated cost, and falls back to the playbooks' step cost", () => {
    const full = slot({ paces: [{ usable: 90, ceiling: 60, headroom: 0, free: 0, projects: ["App"] }] });
    expect(throttle([provider([full], { held: [held("h", { estimatedCost: 8 })] })]).percent).toBe(100);
    const room = slot();
    const project = { projectId: "p", label: "App", unitCost: { claude: { weekly: 34 } }, limits: [limits()] };
    expect(throttle([provider([room])], [project])).toMatchObject({ percent: 50, source: "playbooks" });
  });

  it("has no estimate without a measured cost, and ignores zero-cost runs; it is not throttled", () => {
    expect(throttle([provider([slot()])])).toMatchObject({ percent: null, source: null });
    expect(throttle([provider([slot()], { reservations: [reserving("z", 0.02)] })]).percent).toBeNull();
    expect(projectRows(data([provider([slot()])]))[0]!.throttled).toBe(false);
  });

  it("takes the tightest window, and shows nothing for a project with pacing off", () => {
    const other = slot({ id: "five_hour", name: "5h", paces: [{ usable: 90, ceiling: 10, headroom: 1, free: 1, projects: ["App"] }] });
    const reservations = [{ runId: "a", title: "a", projectId: "p", remaining: { weekly: 17, five_hour: 4 } }];
    expect(throttle([provider([slot(), other], { reservations })]).percent).toBe(75);
    expect(throttle([provider([slot()], { reservations })], [{ projectId: "p", label: "App", limits: [limits({ pacing: false })] }]).percent).toBeNull();
  });

  it("counts held and paused runs, the longest wait and the next retry", () => {
    const now = Date.parse("2026-11-23T00:00:00Z");
    const result = throttleOf({
      slots: [],
      reservations: [],
      unitCost: undefined,
      nowMs: now,
      held: [held("a", { since: "2026-11-22T21:30:00Z", retryAt: "2026-11-23T00:20:00Z" }), held("b", { kind: "pace", since: "2026-11-22T23:00:00Z", retryAt: "2026-11-23T00:05:00Z" }), held("c", { retryAt: "2026-11-22T23:59:00Z" })],
    });
    expect(result).toMatchObject({ held: 2, paused: 1, longestWaitMs: 150 * 60_000, nextRetryAt: "2026-11-23T00:05:00.000Z" });
    expect(formatWait(result.longestWaitMs!)).toBe("2h 30m");
    expect(formatWait(14 * 60_000)).toBe("14m");
    expect(formatWait(5_000)).toBe("<1m");
  });
});

describe("a provider whose usage is unavailable", () => {
  const data = (usage: QuotaProvider["usage"], state: QuotaProvider["state"] = "unavailable"): QuotaLimitation => ({
    now: "2026-11-20T12:00:00.000Z",
    projects: [{ projectId: "p", label: "App", limits: [{ repos: ["default"], pacing: true, usablePercent: 90, stepsLimit: null, runsLimit: null }] }, { projectId: "q", label: "Lib", limits: [{ repos: ["default"], pacing: true, usablePercent: 90, stepsLimit: null, runsLimit: null }] }],
    stepsRunning: 0,
    runsActive: 0,
    limitHeld: [],
    providers: [{ provider: "claude", pacedBy: ["App", "Lib"], state, readAt: "2026-11-20T11:00:00.000Z", ...(usage ? { usage } : {}), overrideUntil: null, windows: [{ id: "weekly", name: "Weekly", modelScoped: false, used: 60, reserved: 0, paces: [{ usable: 90, ceiling: 50, headroom: -10, free: -10, projects: ["App", "Lib"] }], resetsAt: "2026-11-27T00:00:00.000Z", stale: false }], reservations: [], held: [], exhausted: [] }],
  });
  const down = { available: false, since: "2026-11-20T10:42:00.000Z", lastReadAt: "2026-11-20T10:31:00.000Z", reason: "HTTP 429", failures: 4 };

  it("is listed once, whatever the number of projects, with since, reason and last read", () => {
    expect(unavailableProviders(data(down))).toEqual([{ provider: "claude", since: down.since, reason: "HTTP 429", lastReadAt: down.lastReadAt }]);
    expect(projectRows(data(down))).toHaveLength(2);
  });

  it("is not listed while available, nor by an older server that sends no usage field", () => {
    expect(unavailableProviders(data({ ...down, available: true, since: null, reason: null }, "ok"))).toEqual([]);
    expect(unavailableProviders(data(undefined, "ok"))).toEqual([]);
  });

  it("shows the last known windows as stale, over nothing, with no throttle", () => {
    const row = projectRows(data(down))[0]!;
    const provider = row.sets[0]!.providers[0]!;
    expect(provider).toMatchObject({ unavailable: true, status: "unavailable" });
    expect(provider.slots[0]).toMatchObject({ stale: true, used: 60 });
    expect(provider.throttle.percent).toBeNull();
    expect(row.throttled).toBe(false);
  });
});

describe("burn rate rows", () => {
  it("carries the project's burn rates and a reservation's basis through to the rows", () => {
    const burn = [{ playbook: "work", title: "Work", resetAt: "2026-11-24T10:00:00Z", rates: [], steps: [{ id: "a", durationMs: null, resetAt: null }] }];
    const reservation = { runId: "r1", projectId: "p", title: "Work", remaining: { weekly: 3 }, basis: { weekly: { ms: 1_800_000, burnRate: 6 } } };
    const [row] = projectRows(data([provider([slot()], { reservations: [reservation] })], [{ projectId: "p", label: "App", burnRates: burn, limits: [limits()] }]));
    expect(row!.burnRates).toEqual(burn);
    expect(row!.sets[0]!.providers[0]!.reservations[0]!.basis).toEqual({ weekly: { ms: 1_800_000, burnRate: 6 } });
    expect(projectRows(data())[0]!.burnRates).toEqual([]);
  });
});

