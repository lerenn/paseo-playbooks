import { describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../shared/types";
import { attentionOf, indexBadges, runBadge, RECENT_MS } from "./workspace-badges";
import { createBadgeStore } from "./workspace-badges-store";
import type { OverviewSnapshot, OverviewStore } from "./overview-store";

const NOW = Date.parse("2026-11-24T12:00:00Z");

function summary(extra: Partial<RunSummary> & { stepStatuses?: string[] } = {}): RunSummary {
  const { stepStatuses = ["completed", "running", "pending"], ...rest } = extra;
  return {
    id: "r1",
    playbook: { id: "pb", title: "Build", slowWarning: { runs: 10, factor: 2 }, steps: stepStatuses.map((_, i) => ({ id: `s${i}`, afterTask: undefined })) },
    workspaceId: "w1",
    status: "running",
    updatedAt: new Date(NOW - 60_000).toISOString(),
    pausedAt: null,
    rateHold: null,
    steps: Object.fromEntries(stepStatuses.map((status, i) => [`s${i}`, { status, startedAt: null, endedAt: null }])),
    gates: [],
    after: {},
    ...rest,
  } as unknown as RunSummary;
}
const gate = { status: "pending", stepId: "s1" };

describe("run badge", () => {
  it("maps each state to a tone, with the step count", () => {
    expect(runBadge(summary())).toMatchObject({ state: "running", tone: "info", done: 1, total: 3, playbook: "Build" });
    expect(runBadge(summary({ gates: [gate] as never })).tone).toBe("warning");
    expect(runBadge(summary({ gates: [gate] as never })).state).toBe("waiting");
    expect(runBadge(summary({ pausedAt: "x" }))).toMatchObject({ state: "paused", tone: "violet" });
    expect(runBadge(summary({ status: "completed" }))).toMatchObject({ state: "done", tone: "success" });
    expect(runBadge(summary({ status: "failed" }))).toMatchObject({ state: "failed", tone: "danger" });
    expect(runBadge(summary({ status: "canceled" }))).toMatchObject({ state: "canceled", tone: "muted" });
  });
  it("a hold is held with nothing running, running while a step still works", () => {
    const hold = { kind: "quota", reason: "r" } as never;
    expect(runBadge(summary({ rateHold: hold, stepStatuses: ["completed", "pending"] })).tone).toBe("violet");
    expect(runBadge(summary({ rateHold: hold })).state).toBe("running");
  });
});

describe("attention badge", () => {
  it("is null unless the user is needed", () => {
    expect(attentionOf(summary(), false)).toBeNull();
    expect(attentionOf(summary({ status: "failed" }), true)).toBeNull();
    expect(attentionOf(summary({ gates: [gate] as never }), false)).toEqual({ kind: "gate", tone: "danger" });
    expect(attentionOf(summary(), true)).toEqual({ kind: "slow", tone: "warning" });
    // Held by rate limiting with nothing running: the run badge says it, the attention badge stays away.
    expect(attentionOf(summary({ rateHold: { kind: "quota", reason: "r" } as never, stepStatuses: ["pending"] }), false)).toBeNull();
  });
});

describe("index", () => {
  it("keeps active and recent runs, by workspace, the active one first", () => {
    const old = summary({ id: "old", workspaceId: "w2", status: "completed", updatedAt: new Date(NOW - RECENT_MS - 1).toISOString() });
    const recent = summary({ id: "recent", workspaceId: "w3", status: "completed" });
    const finished = summary({ id: "fin", status: "completed" });
    const live = summary({ id: "live", gates: [gate] as never, updatedAt: new Date(NOW - 3_600_000).toISOString() });
    const index = indexBadges([finished, live, old, recent], NOW);
    expect([...index.keys()].sort()).toEqual(["w1", "w3"]);
    expect(index.get("w1")!.run.runId).toBe("live");
    expect(index.get("w1")!.attention?.kind).toBe("gate");
    expect(index.get("w3")!.attention).toBeNull();
  });
});

describe("held run in the index", () => {
  it("shows violet on the run badge and no attention badge", () => {
    const held = summary({ rateHold: { kind: "quota", reason: "r" } as never, stepStatuses: ["completed", "pending"] });
    const badges = indexBadges([held], NOW).get("w1")!;
    expect(badges.run).toMatchObject({ state: "held", tone: "violet" });
    expect(badges.attention).toBeNull();
  });
});

describe("badge store", () => {
  function overview(runs: RunSummary[] | null) {
    let snapshot: OverviewSnapshot = { count: 0, runs, error: null };
    const subscribe = vi.fn((_listener: () => void) => () => undefined);
    const release = vi.fn();
    const watchRuns = vi.fn(() => release);
    const store = { subscribe, get: () => snapshot, watchRuns, refresh: vi.fn() } as unknown as OverviewStore;
    return { store, subscribe, watchRuns, release, set: (next: RunSummary[] | null) => (snapshot = { ...snapshot, runs: next }) };
  }

  it("asks for the runs once for any number of rows, and releases them with the last row", () => {
    const o = overview([summary()]);
    const badges = createBadgeStore(o.store, () => NOW);
    const stops = Array.from({ length: 30 }, () => badges.subscribe(() => undefined));
    expect(o.subscribe).toHaveBeenCalledTimes(1);
    expect(o.watchRuns).toHaveBeenCalledTimes(1);
    stops.slice(1).forEach((stop) => stop());
    expect(o.release).not.toHaveBeenCalled();
    stops[0]!();
    expect(o.release).toHaveBeenCalledTimes(1);
  });

  it("builds the index once per set of runs, however many rows read it", () => {
    const o = overview([summary()]);
    const badges = createBadgeStore(o.store, () => NOW);
    const first = badges.get();
    for (let row = 0; row < 50; row++) expect(badges.get()).toBe(first);
    expect(first.get("w1")?.run.state).toBe("running");
    o.set([summary({ status: "failed" })]);
    expect(badges.get()).not.toBe(first);
    expect(badges.get().get("w1")?.run.state).toBe("failed");
    o.set(null);
    expect(badges.get().size).toBe(0);
  });
});
