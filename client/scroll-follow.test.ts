import { describe, expect, it } from "vitest";
import type { Item } from "./sidekick/reduce";
import { AWAY_MIN_PX, HYSTERESIS_PX, awayThreshold, badgeLabel, leftAt, scrollButtonVisible, unreadSince } from "./scroll-follow";

const a = (key: string, text = "x"): Item => ({ kind: "assistant", key, text, streaming: false });
const tool = (key: string): Item => ({ kind: "tool", key, callId: key, name: "t", status: "running", detail: null, error: null });
const view = (shown: boolean, distance: number, viewportHeight = 240) => scrollButtonVisible({ shown, contentHeight: 2000, offsetY: 2000 - viewportHeight - distance, viewportHeight, stickPx: 40 });

describe("scroll to bottom: visibility", () => {
  it("uses 80px or a third of the viewport, whichever is larger", () => {
    expect(awayThreshold(240)).toBe(AWAY_MIN_PX);
    expect(awayThreshold(900)).toBe(300);
  });
  it("shows only beyond the threshold", () => {
    expect(view(false, 80)).toBe(false);
    expect(view(false, 81)).toBe(true);
    expect(view(false, 250, 900)).toBe(false);
    expect(view(false, 301, 900)).toBe(true);
    expect(view(false, 0)).toBe(false);
  });
  it("hides again only a little closer than it showed (hysteresis)", () => {
    expect(view(true, 81)).toBe(true);
    expect(view(true, 80 - HYSTERESIS_PX + 1)).toBe(true);
    expect(view(true, 80 - HYSTERESIS_PX)).toBe(false);
    expect(view(true, 0)).toBe(false);
  });
  it("never stays visible inside the follow distance", () => {
    expect(scrollButtonVisible({ shown: true, contentHeight: 1000, offsetY: 640, viewportHeight: 330, stickPx: 40 })).toBe(false);
  });
  it("a short chat (content under the viewport) shows nothing", () => {
    expect(scrollButtonVisible({ shown: false, contentHeight: 100, offsetY: 0, viewportHeight: 400, stickPx: 40 })).toBe(false);
  });
});

describe("scroll to bottom: unread count", () => {
  const before = [a("1"), a("2", "hello")];
  it("is 0 until something arrives, and without an anchor", () => {
    expect(unreadSince(leftAt(before), before)).toBe(0);
    expect(unreadSince(null, before)).toBe(0);
    expect(leftAt([])).toBeNull();
  });
  it("counts each new message, not tool calls", () => {
    expect(unreadSince(leftAt(before), [...before, a("3"), tool("t1"), a("4")])).toBe(2);
  });
  it("counts growth of the last message once, however many tokens", () => {
    const left = leftAt(before);
    expect(unreadSince(left, [a("1"), a("2", "hello w")])).toBe(1);
    expect(unreadSince(left, [a("1"), a("2", "hello world, and much more")])).toBe(1);
    expect(unreadSince(left, [a("1"), a("2", "hello world, and much more"), a("3")])).toBe(2);
  });
  it("ignores older entries added above", () => {
    expect(unreadSince(leftAt(before), [a("-1"), a("0"), ...before])).toBe(0);
  });
  it("is 0 when the timeline was replaced", () => {
    expect(unreadSince(leftAt(before), [a("9")])).toBe(0);
  });
  it("resets by dropping the anchor (the reader is back at the bottom)", () => {
    expect(unreadSince(null, [...before, a("3")])).toBe(0);
  });
  it("caps the badge", () => {
    expect(badgeLabel(3)).toBe("3");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
  });
});
