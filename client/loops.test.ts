import { describe, expect, it } from "vitest";
import { assignLanes, groupLoops, loopText, type LoopEdge } from "./loops";

const edge = (from: string, to: string, outcome: string, count = 0, max: number | undefined = 3): LoopEdge => ({ from, to, outcome, count, max });

describe("groupLoops", () => {
  it("merges the outcomes of one source to one target into a single group", () => {
    const groups = groupLoops([edge("a", "b", "x"), edge("a", "b", "y", 1), edge("a", "c", "z")]);
    expect(groups.map((g) => [g.key, g.edges.length])).toEqual([["a->b", 2], ["a->c", 1]]);
    expect(groups[0]!.label).toBe("2 loops · 1 taken");
    expect(groups[1]!.label).toBe("z · 0/3");
  });
  it("keeps every outcome and its counter reachable", () => {
    const [group] = groupLoops([edge("a", "b", "blocked: retry", 2, 3), { from: "a", to: "b", outcome: "head_changed", count: 0, max: undefined }]);
    expect(group!.edges.map(loopText)).toEqual(["blocked: retry · 2/3", "head_changed"]);
  });
  it("is exhausted only when every outcome is at its limit", () => {
    expect(groupLoops([edge("a", "b", "x", 3), edge("a", "b", "y", 1)])[0]!.exhausted).toBe(false);
    expect(groupLoops([edge("a", "b", "x", 3), edge("a", "b", "y", 3)])[0]!.exhausted).toBe(true);
  });
});

describe("assignLanes", () => {
  const layers: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4 };
  const lane = (groups: ReturnType<typeof groupLoops>) => assignLanes(groups, (id) => layers[id]!);
  it("shares a lane between groups whose spans do not overlap", () => {
    const { lanes, count } = lane(groupLoops([edge("b", "a", "x"), edge("e", "d", "y")]));
    expect(count).toBe(1);
    expect(lanes.get("b->a")).toBe(lanes.get("e->d"));
  });
  it("separates overlapping spans", () => {
    const { lanes, count } = lane(groupLoops([edge("d", "a", "x"), edge("c", "b", "y")]));
    expect(count).toBe(2);
    expect(lanes.get("d->a")).not.toBe(lanes.get("c->b"));
  });
  it("uses at most one lane per group", () => {
    expect(lane(groupLoops([edge("d", "a", "x"), edge("d", "b", "y"), edge("d", "c", "z")])).count).toBe(3);
  });
});
