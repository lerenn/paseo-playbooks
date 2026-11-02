import { describe, expect, it } from "vitest";
import { ancestorsOf, descendantsOf, END, findCycle, layoutGraph, START, withTerminals } from "../shared/graph";

const PR = [
  { id: "investigate", needs: [] },
  { id: "implement", needs: ["investigate"] },
  { id: "review", needs: ["implement"] },
  { id: "local_qa", needs: ["implement"] },
  { id: "babysit", needs: ["review", "local_qa"] },
  { id: "pr_approval", needs: ["babysit"] },
];

describe("graph", () => {
  it("lays out the PR playbook in layers with fork and join", () => {
    const layout = layoutGraph(PR);
    expect(layout.layers).toEqual([["investigate"], ["implement"], ["review", "local_qa"], ["babysit"], ["pr_approval"]]);
    expect(layout.edges).toContainEqual({ from: "local_qa", to: "babysit" });
    expect(layout.edges).toHaveLength(6);
  });

  it("places a step one layer below its deepest need, regardless of file order", () => {
    const layout = layoutGraph([
      { id: "c", needs: ["a", "b"] },
      { id: "b", needs: ["a"] },
      { id: "a", needs: [] },
    ]);
    expect(layout.layers).toEqual([["a"], ["b"], ["c"]]);
  });

  it("computes ancestors and descendants", () => {
    expect([...ancestorsOf(PR, "babysit")].sort()).toEqual(["implement", "investigate", "local_qa", "review"]);
    expect([...descendantsOf(PR, "implement")].sort()).toEqual(["babysit", "local_qa", "pr_approval", "review"]);
  });

  it("finds cycles", () => {
    expect(findCycle(PR)).toBeNull();
    expect(findCycle([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }])).toEqual(["a", "b", "a"]);
  });
});

describe("withTerminals", () => {
  it("puts Start above the roots and End below every sink", () => {
    const layout = layoutGraph(withTerminals([...PR, { id: "notes", needs: ["investigate"] }]));
    expect(layout.layers[0]).toEqual([START]);
    expect(layout.layers.at(-1)).toEqual([END]);
    expect(layout.edges).toContainEqual({ from: START, to: "investigate" });
    expect(layout.edges.filter((edge) => edge.to === END).map((edge) => edge.from).sort()).toEqual(["notes", "pr_approval"]);
  });
});
