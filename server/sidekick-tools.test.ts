import { describe, expect, it } from "vitest";
import { SIDEKICK_PLUGIN_TOOLS } from "./sidekick";
import { managerTools, runTools, sidekickStartTools, sidekickTool, validateTool } from "./tools";
import type { Runtime } from "./runtime";

const runtime = {} as Runtime;

describe("the Sidekick's tools", () => {
  const given = [...sidekickStartTools(runtime), ...runTools(runtime), validateTool(runtime), sidekickTool(runtime)].map((tool) => tool.name);

  it("gets start_playbook and list_playbooks, and no other manager tool", () => {
    expect(sidekickStartTools(runtime).map((tool) => tool.name).sort()).toEqual(["list_playbooks", "start_playbook"]);
    expect(managerTools(runtime).map((tool) => tool.name)).toEqual(expect.arrayContaining(["start_playbook", "settle_job"]));
    expect(given).not.toContain("settle_job");
  });

  it("is given every plugin tool it is preapproved for", () => {
    for (const name of SIDEKICK_PLUGIN_TOOLS) expect(given, name).toContain(name);
  });

  it("is given the job and slow-step tools", () => {
    expect(given).toEqual(expect.arrayContaining(["record_followup", "requeue_job", "list_runs", "start_after_task"]));
  });
});
