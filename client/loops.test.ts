import { describe, expect, it } from "vitest";
import { activeStep, assignLanes, badgeText, groupLoops, relatedLoops, loopText, type LoopEdge, visibleAttempts } from "./loops";

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

describe("badgeText", () => {
  it("counts outcomes and loops taken", () => {
    const [g] = groupLoops([edge("a", "b", "x", 40), edge("a", "b", "y", 40)]);
    expect(badgeText(g!, "Fix it")).toBe("↩ Fix it · 2 outcomes · 80 taken");
  });
  it("shows a lone outcome with its counter", () => {
    expect(badgeText(groupLoops([edge("a", "b", "x", 1)])[0]!, "Fix it")).toBe("↩ Fix it · x · 1/3");
  });
});

describe("visibleAttempts", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  it("shows few attempts in full", () => {
    expect(visibleAttempts(list(6), false)).toEqual({ shown: list(6), hidden: 0 });
  });
  it("collapses many attempts to the latest ones", () => {
    expect(visibleAttempts(list(44), false)).toEqual({ shown: [41, 42, 43, 44], hidden: 40 });
  });
  it("shows everything once expanded", () => {
    expect(visibleAttempts(list(44), true).shown).toHaveLength(44);
  });
});

describe("assignLanes", () => {
  const layer = (id: string) => ({ a: 0, b: 1, c: 2, d: 3, e: 4 })[id as "a"]!;
  it("shares a lane between loops whose spans do not overlap", () => {
    const { lanes, count } = assignLanes(groupLoops([edge("b", "a", "x"), edge("e", "d", "y")]), layer);
    expect(count).toBe(1);
    expect(lanes.get("b->a")).toBe(lanes.get("e->d"));
  });
  it("separates loops whose spans overlap", () => {
    const { lanes, count } = assignLanes(groupLoops([edge("d", "a", "x"), edge("c", "b", "y")]), layer);
    expect(count).toBe(2);
    expect(lanes.get("d->a")).not.toBe(lanes.get("c->b"));
  });
});

describe("relatedLoops and activeStep", () => {
  const groups = groupLoops([edge("b", "a", "x"), edge("d", "c", "y"), edge("e", "a", "z")]);
  it("selects the lines leaving and entering a step", () => {
    expect([...relatedLoops(groups, "a")].sort()).toEqual(["b->a", "e->a"]);
    expect([...relatedLoops(groups, "d")]).toEqual(["d->c"]);
    expect(relatedLoops(groups, null).size).toBe(0);
  });
  it("prefers the hovered step over the pinned one", () => {
    expect(activeStep("a", "b")).toBe("a");
    expect(activeStep(null, "b")).toBe("b");
    expect(activeStep(null, null)).toBeNull();
  });
});
