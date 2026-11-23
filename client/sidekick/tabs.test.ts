import { describe, expect, it } from "vitest";
import type { SidekickProject } from "../../shared/contracts";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { messages } from "../i18n";
import { statusLine as statusWith, visibleTabs } from "./tabs";

const runtime = new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} });
const statusLine = (project: Parameters<typeof statusWith>[1]) => statusWith((key, params) => runtime.t(messages, key as never, params as never) as string, project);

const project = (projectId: string, over: Partial<SidekickProject> = {}): SidekickProject => ({ projectId, workspaceId: `ws-${projectId}`, label: projectId, configured: false, errors: [], agentId: null, activeRuns: 0, needYou: 0, compacting: false, ...over });

describe("visibleTabs", () => {
  it("shows projects with active runs or a Sidekick, and those added, most active first", () => {
    const projects = [project("idle"), project("quiet", { agentId: "a1" }), project("busy", { activeRuns: 3 }), project("added"), project("zeta", { activeRuns: 1 })];
    expect(visibleTabs(projects, ["added"]).map((tab) => tab.projectId)).toEqual(["busy", "zeta", "added", "quiet"]);
  });

  it("is empty when nothing qualifies", () => {
    expect(visibleTabs([project("a"), project("b")], [])).toEqual([]);
  });
});

describe("statusLine", () => {
  it("counts what needs the human and what is working", () => {
    expect(statusLine({ activeRuns: 3, needYou: 2 })).toBe("2 need you · 3 working");
    expect(statusLine({ activeRuns: 1, needYou: 0 })).toBe("1 working");
    expect(statusLine({ activeRuns: 0, needYou: 0 })).toBeNull();
  });
});
