/**
 * Layout of the labelled frames drawn around the steps of each expanded sub-playbook. Every frame owns a
 * header strip (HEADER_H tall, the toggle) above its content, and the layer layout reserves room for it, so
 * the header never overlaps a step card, and edges are cut where they would cross a header.
 */
export const HEADER_H = 32;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Space between a frame's border and what it holds; shrinks with nesting so levels stay readable. */
export function framePad(depth: number): number {
  return Math.max(4, 10 - depth * 4);
}

export function frameDepth(prefix: string): number {
  return prefix.split(".").length - 1;
}

const isInside = (outer: string, inner: string) => inner.startsWith(`${outer}.`);

export interface FrameInput {
  prefix: string;
  /** Boxes of the nodes shown inside it (nested ones included). */
  members: Box[];
}

export interface FrameRect {
  prefix: string;
  depth: number;
  box: Box;
  /** The toggle strip, along the top of the frame. */
  header: Box;
}

/** Frame boxes: members plus the frames nested in it, padded, with the header on top. Parents wrap children. */
export function frameRects(frames: readonly FrameInput[]): FrameRect[] {
  const done = new Map<string, FrameRect>();
  const ordered = [...frames].sort((a, b) => frameDepth(b.prefix) - frameDepth(a.prefix));
  for (const frame of ordered) {
    const boxes = [...frame.members, ...[...done.values()].filter((other) => isInside(frame.prefix, other.prefix)).map((other) => other.box)];
    if (boxes.length === 0) continue;
    const depth = frameDepth(frame.prefix);
    const pad = framePad(depth);
    const box: Box = {
      left: Math.min(...boxes.map((b) => b.left)) - pad,
      right: Math.max(...boxes.map((b) => b.right)) + pad,
      top: Math.min(...boxes.map((b) => b.top)) - pad - HEADER_H,
      bottom: Math.max(...boxes.map((b) => b.bottom)) + pad,
    };
    done.set(frame.prefix, { prefix: frame.prefix, depth, box, header: { left: box.left, right: box.right, top: box.top, bottom: box.top + HEADER_H } });
  }
  return [...done.values()].sort((a, b) => a.depth - b.depth);
}

/**
 * Vertical room each layer needs above its nodes for the headers of the frames starting there (a frame
 * and the frames nested in it that start on the same layer stack their headers).
 */
export function layerHeadroom(frames: readonly { prefix: string; layer: number }[]): Map<number, number> {
  const need = new Map<string, number>();
  const ordered = [...frames].sort((a, b) => frameDepth(b.prefix) - frameDepth(a.prefix));
  const heads = new Map<number, number>();
  for (const frame of ordered) {
    const inner = ordered.filter((other) => isInside(frame.prefix, other.prefix) && other.layer === frame.layer).map((other) => need.get(other.prefix) ?? 0);
    const h = framePad(frameDepth(frame.prefix)) + HEADER_H + Math.max(0, ...inner);
    need.set(frame.prefix, h);
    heads.set(frame.layer, Math.max(heads.get(frame.layer) ?? 0, h));
  }
  return heads;
}

/** The parts of a vertical line at `x` (a stroke wide), from y0 to y1, that no header covers. */
export function clearOfHeaders(x: number, stroke: number, y0: number, y1: number, headers: readonly Box[]): Array<[number, number]> {
  let parts: Array<[number, number]> = [[y0, y1]];
  for (const h of headers) {
    if (x + stroke / 2 <= h.left || x - stroke / 2 >= h.right) continue;
    parts = parts.flatMap(([a, b]): Array<[number, number]> => {
      if (b <= h.top || a >= h.bottom) return [[a, b]];
      const out: Array<[number, number]> = [];
      if (a < h.top) out.push([a, h.top]);
      if (b > h.bottom) out.push([h.bottom, b]);
      return out;
    });
  }
  return parts;
}
