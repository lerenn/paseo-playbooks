import { describe, expect, it } from "vitest";
import type { SidekickProject } from "../../shared/contracts";
import { visibleTabs } from "./tabs";

const project = (projectId: string, over: Partial<SidekickProject> = {}): SidekickProject => ({ projectId, workspaceId: `ws-${projectId}`, label: projectId, configured: false, errors: [], agentId: null, activeRuns: 0, ...over });

describe("visibleTabs", () => {
  it("shows projects with active runs or a Sidekick, and those added, most active first", () => {
    const projects = [project("idle"), project("quiet", { agentId: "a1" }), project("busy", { activeRuns: 3 }), project("added"), project("zeta", { activeRuns: 1 })];
    expect(visibleTabs(projects, ["added"]).map((tab) => tab.projectId)).toEqual(["busy", "zeta", "added", "quiet"]);
  });

  it("is empty when nothing qualifies", () => {
    expect(visibleTabs([project("a"), project("b")], [])).toEqual([]);
  });
});
