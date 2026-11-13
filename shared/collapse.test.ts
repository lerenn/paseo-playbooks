import { describe, expect, it } from "vitest";
import { blockStats, blockStatus, collapseNodes, EMPTY_COLLAPSE, groupNodeId, isCollapsed, markSeen, progressText, toggled, type StepProgress } from "./collapse";
import { layoutGraph } from "./graph";
import type { StepStatus } from "./types";

const ids = ["a", "pr.build", "pr.test", "pr.deep.lint", "pr.deep.fmt", "z"];
const steps = [
  { id: "a", needs: [] },
  { id: "pr.build", needs: ["a"] },
  { id: "pr.test", needs: ["pr.build"] },
  { id: "pr.deep.lint", needs: ["pr.build"] },
  { id: "pr.deep.fmt", needs: ["pr.deep.lint"] },
  { id: "z", needs: ["pr.test", "pr.deep.fmt"] },
];
const at = (map: Record<string, StepStatus>) => (id: string): StepProgress | undefined => (map[id] ? { status: map[id]!, startedAt: [] } : undefined);

describe("blockStats", () => {
  it("counts the steps of a block, nested ones included", () => {
    const stats = blockStats("pr", ids, at({ "pr.build": "completed", "pr.test": "running", "pr.deep.lint": "skipped" }));
    expect(stats).toMatchObject({ total: 4, done: 2, running: 1, attention: 1, failed: 0 });
    expect(progressText(stats)).toBe("2/4 steps");
    expect(blockStats("pr.deep", ids, at({})).total).toBe(2);
    expect(progressText(blockStats("nope", ids, at({})))).toBe("0/0 steps");
  });
  it("keeps the earliest attempt start", () => {
    const stats = blockStats("pr", ids, (id) => ({ status: "completed", startedAt: id === "pr.test" ? ["2026-01-01T00:00:10Z", "2026-01-01T00:00:05Z"] : [undefined] }));
    expect(stats.startedAt).toBe("2026-01-01T00:00:05Z");
  });
  it("gives a status: failed, running, waiting, completed, else pending", () => {
    const status = (map: Record<string, StepStatus>) => blockStatus(blockStats("pr", ids, at(map)));
    expect(status({ "pr.build": "failed", "pr.test": "running" })).toBe("failed");
    expect(status({ "pr.build": "running" })).toBe("running");
    expect(status({ "pr.build": "waiting" })).toBe("waiting");
    expect(status({ "pr.build": "completed", "pr.test": "completed", "pr.deep.lint": "completed", "pr.deep.fmt": "skipped" })).toBe("completed");
    expect(status({ "pr.build": "completed" })).toBe("pending");
  });
});

describe("isCollapsed", () => {
  const idle = blockStats("pr", ids, at({ "pr.build": "completed" }));
  const busy = blockStats("pr", ids, at({ "pr.build": "running" }));
  it("is collapsed by default while no step needs attention", () => {
    expect(isCollapsed("pr", idle, EMPTY_COLLAPSE, true)).toBe(true);
  });
  it("is open while a step runs, waits, is ready or failed", () => {
    for (const status of ["running", "waiting", "ready", "failed", "reported", "queued"] as const) {
      expect(isCollapsed("pr", blockStats("pr", ids, at({ "pr.build": status })), EMPTY_COLLAPSE, true)).toBe(false);
    }
    expect(isCollapsed("pr", busy, EMPTY_COLLAPSE, true)).toBe(false);
  });
  it("is open in the definition, where nothing runs", () => {
    expect(isCollapsed("pr", idle, EMPTY_COLLAPSE, false)).toBe(false);
  });
  it("never collapses by itself a group that was open: it stays when the step finishes", () => {
    const state = markSeen(EMPTY_COLLAPSE, { pr: busy });
    expect(state.seen).toEqual(["pr"]);
    expect(isCollapsed("pr", idle, state, true)).toBe(false);
    expect(markSeen(state, { pr: busy })).toBe(state);
  });
  it("lets a manual choice win both ways, also over a later start", () => {
    const folded = toggled(EMPTY_COLLAPSE, "pr", false);
    expect(isCollapsed("pr", busy, folded, true)).toBe(true);
    const opened = toggled(EMPTY_COLLAPSE, "pr", true);
    expect(isCollapsed("pr", idle, opened, true)).toBe(false);
  });
  it("has its own state for each nested group", () => {
    const inner = blockStats("pr.deep", ids, at({ "pr.deep.lint": "running" }));
    const outer = blockStats("pr", ids, at({ "pr.deep.lint": "running" }));
    expect(isCollapsed("pr", outer, EMPTY_COLLAPSE, true)).toBe(false);
    expect(isCollapsed("pr.deep", inner, EMPTY_COLLAPSE, true)).toBe(false);
    expect(isCollapsed("pr.deep", blockStats("pr.deep", ids, at({ "pr.build": "running" })), EMPTY_COLLAPSE, true)).toBe(true);
  });
});

describe("collapseNodes", () => {
  it("turns a collapsed block into one node that keeps its edges", () => {
    const { nodes, nodeOf, prefixes } = collapseNodes(steps, new Set(["pr"]));
    expect(nodes).toEqual([
      { id: "a", needs: [] },
      { id: groupNodeId("pr"), needs: ["a"] },
      { id: "z", needs: [groupNodeId("pr")] },
    ]);
    expect(nodeOf("pr.deep.fmt")).toBe("pr.__block");
    expect(nodeOf("z")).toBe("z");
    expect(prefixes.get("pr.__block")).toBe("pr");
    expect(layoutGraph(nodes).layers).toEqual([["a"], ["pr.__block"], ["z"]]);
  });
  it("collapses only the nested block, keeping the parent's other steps", () => {
    const { nodes } = collapseNodes(steps, new Set(["pr.deep"]));
    expect(nodes.map((node) => node.id)).toEqual(["a", "pr.build", "pr.test", "pr.deep.__block", "z"]);
    expect(nodes.find((node) => node.id === "pr.deep.__block")!.needs).toEqual(["pr.build"]);
    expect(nodes.find((node) => node.id === "z")!.needs).toEqual(["pr.test", "pr.deep.__block"]);
  });
  it("lets the outermost collapsed block hide its children", () => {
    const { nodes } = collapseNodes(steps, new Set(["pr", "pr.deep"]));
    expect(nodes.map((node) => node.id)).toEqual(["a", "pr.__block", "z"]);
  });
  it("changes nothing when nothing is collapsed", () => {
    expect(collapseNodes(steps, new Set()).nodes).toEqual(steps);
  });
});
