import { describe, expect, it, vi } from "vitest";
import { UsageCache, usageBlock, windowAppliesTo, windowModel } from "./usage";

const snap = (windows: Array<Record<string, unknown>>, status = "available") => ({ providers: [{ providerId: "claude", status, windows }] }) as never;

describe("usageBlock", () => {
  it("blocks at the threshold or when nothing remains", () => {
    expect(usageBlock(snap([{ id: "weekly", usedPct: 99 }]), "claude", "m", 100)).toBeNull();
    expect(usageBlock(snap([{ id: "weekly", usedPct: 100, resetsAt: "2999-01-01T00:00:00Z" }]), "claude", "m", 100)).toMatchObject({ window: "weekly", usedPct: 100 });
    expect(usageBlock(snap([{ id: "weekly", usedPct: 90 }]), "claude", "m", 90)).not.toBeNull();
    expect(usageBlock(snap([{ id: "weekly", usedPct: 80, remainingPct: 0 }]), "claude", "m", 100)).not.toBeNull();
  });
  it("is null without usable information", () => {
    expect(usageBlock(null, "claude", "m", 100)).toBeNull();
    expect(usageBlock(snap([{ id: "weekly", usedPct: 100 }]), "codex", "m", 100)).toBeNull();
    expect(usageBlock(snap([{ id: "weekly", usedPct: 100 }], "unavailable"), "claude", "m", 100)).toBeNull();
    expect(usageBlock(snap([]), "claude", "m", 100)).toBeNull();
  });
  it("names the model of a model window", () => {
    expect(windowModel("weekly")).toBeNull();
    expect(windowModel("weekly_model_fable")).toBe("fable");
    expect(windowAppliesTo("weekly_model_fable", "claude-fable-5-1")).toBe(true);
    expect(windowAppliesTo("weekly_model_fable", "claude-opus-5-5")).toBe(false);
    expect(windowAppliesTo("weekly_model_fable", undefined)).toBe(false);
    expect(windowAppliesTo("weekly", "anything")).toBe(true);
  });
});

describe("UsageCache", () => {
  it("shares an in-flight call, memoizes, and expires", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => ({ providers: [] }));
      const cache = new UsageCache(fetch);
      await Promise.all([cache.read(), cache.read()]);
      await cache.read();
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      await cache.read();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("is bounded by nextRefreshAt and returns null on failure", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => ({ providers: [], nextRefreshAt: new Date(Date.now() + 10_000).toISOString() }));
      const cache = new UsageCache(fetch);
      await cache.read();
      vi.advanceTimersByTime(11_000);
      await cache.read();
      expect(fetch).toHaveBeenCalledTimes(2);
      const failing = new UsageCache(async () => {
        throw new Error("down");
      });
      expect(await failing.read()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
