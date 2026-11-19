import { describe, expect, it } from "vitest";
import type { Item } from "./reduce";
import { FIRST_PAGE, NEAR_TOP_PX, OLDER_PAGE, RELOAD_PAGE, STICK_PX, isPrepend, isStuck, offsetAfterPrepend, seqOf, shouldLoadOlder } from "./window";

const item = (key: string): Item => ({ kind: "assistant", key, text: key, streaming: false });

describe("sidekick window", () => {
  it("opens with a small first page and re-reads wider after a reconnect", () => {
    expect(FIRST_PAGE).toBe(40);
    expect(OLDER_PAGE).toBeGreaterThan(0);
    expect(RELOAD_PAGE).toBeGreaterThan(FIRST_PAGE);
  });

  it("keeps the reader's place when older entries are added above", () => {
    // 1000px of new content above a reader at 50px: the view moves down by the same amount.
    expect(offsetAfterPrepend({ height: 3000, offsetY: 50 }, 4000)).toBe(1050);
    expect(offsetAfterPrepend({ height: 3000, offsetY: 0 }, 3000)).toBe(0);
    // Content that shrank (the loading row went away) never gives a negative offset.
    expect(offsetAfterPrepend({ height: 3000, offsetY: 5 }, 2000)).toBe(0);
  });

  it("follows the end only within a few pixels of the bottom (unchanged rule)", () => {
    expect(isStuck(1000, 600, 400)).toBe(true);
    expect(isStuck(1000, 600 - STICK_PX, 400)).toBe(true);
    expect(isStuck(1000, 600 - STICK_PX - 1, 400)).toBe(false);
    expect(isStuck(300, 0, 400)).toBe(true);
  });

  it("reads older entries near the top, one page at a time, only while some remain", () => {
    expect(shouldLoadOlder({ offsetY: NEAR_TOP_PX, hasMore: true, loading: false })).toBe(true);
    expect(shouldLoadOlder({ offsetY: NEAR_TOP_PX + 1, hasMore: true, loading: false })).toBe(false);
    expect(shouldLoadOlder({ offsetY: 0, hasMore: true, loading: true })).toBe(false);
    expect(shouldLoadOlder({ offsetY: 0, hasMore: false, loading: false })).toBe(false);
  });

  it("tells a prepend from a live append, so only the latter may follow the end", () => {
    const now = [item("seq:5"), item("seq:6")];
    expect(isPrepend(now, [item("seq:3"), item("seq:4"), ...now])).toBe(true);
    expect(isPrepend(now, [...now, item("live:1")])).toBe(false);
    expect(isPrepend([], now)).toBe(false);
    expect(isPrepend(now, now)).toBe(false);
    // A replaced window that does not contain the old first item is not a prepend.
    expect(isPrepend(now, [item("seq:9")])).toBe(false);
  });

  it("reads the sequence number of a key", () => {
    expect(seqOf("seq:12")).toBe(12);
    expect(seqOf("live:3")).toBeNull();
    expect(seqOf("tool:abc")).toBeNull();
  });
});
