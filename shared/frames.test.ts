import { describe, expect, it } from "vitest";
import { clearOfHeaders, frameRects, HEADER_H, layerHeadroom, type Box } from "./frames";

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const card = (left: number, top: number): Box => ({ left, top, right: left + 100, bottom: top + 60 });

describe("frame layout", () => {
  it("reserves a header above the first child, with no overlap", () => {
    const head = layerHeadroom([{ prefix: "pr", layer: 2 }]).get(2)!;
    expect(head).toBeGreaterThanOrEqual(HEADER_H);
    const first = card(20, 200 + head);
    const [frame] = frameRects([{ prefix: "pr", members: [first] }]);
    expect(frame!.header.bottom - frame!.header.top).toBeGreaterThanOrEqual(32);
    expect(overlap(frame!.header, first)).toBe(false);
    expect(frame!.box.top).toBeGreaterThanOrEqual(200);
  });

  it("gives each nested frame its own header", () => {
    const head = layerHeadroom([
      { prefix: "pr", layer: 1 },
      { prefix: "pr.deep", layer: 1 },
    ]).get(1)!;
    expect(head).toBeGreaterThanOrEqual(2 * HEADER_H);
    const first = card(20, 100 + head);
    const frames = frameRects([
      { prefix: "pr", members: [first, card(20, 300)] },
      { prefix: "pr.deep", members: [first] },
    ]);
    const [outer, inner] = frames;
    expect(outer!.prefix).toBe("pr");
    expect(overlap(outer!.header, inner!.header)).toBe(false);
    expect(overlap(outer!.header, inner!.box)).toBe(false);
    expect(overlap(inner!.header, first)).toBe(false);
    expect(outer!.box.top).toBeGreaterThanOrEqual(100);
  });

  it("does not stack headers of frames that start on different layers", () => {
    const heads = layerHeadroom([
      { prefix: "pr", layer: 1 },
      { prefix: "pr.deep", layer: 3 },
    ]);
    expect(heads.get(1)).toBeLessThan(2 * HEADER_H);
    expect(heads.get(3)).toBeLessThan(2 * HEADER_H);
  });

  it("cuts an edge where it would cross a header, and keeps the rest", () => {
    const [frame] = frameRects([{ prefix: "pr", members: [card(20, 150)] }]);
    const header = frame!.header;
    const parts = clearOfHeaders(70, 2, 0, 150, [header]);
    for (const [a, b] of parts) expect(a < header.bottom && b > header.top).toBe(false);
    expect(parts[0]![0]).toBe(0);
    expect(parts.at(-1)![1]).toBe(150);
    expect(clearOfHeaders(500, 2, 0, 150, [header])).toEqual([[0, 150]]);
  });
});
