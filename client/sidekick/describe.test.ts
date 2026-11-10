import { describe, expect, it } from "vitest";
import { describePermission, shortToolName } from "./describe";

describe("describePermission", () => {
  it("says what the Sidekick wants to do, with the key arguments on one line", () => {
    expect(describePermission("mcp__paseo__update_agent", { agentId: "a1", name: "Playbooks Sidekick" })).toEqual({
      sentence: "The Sidekick wants to rename this conversation",
      summary: "name: Playbooks Sidekick",
      toolId: "mcp__paseo__update_agent",
    });
    expect(describePermission("mcp__paseo__create_agent", { title: "Fix CI", provider: "claude", workspaceId: "w1" })).toMatchObject({
      sentence: "The Sidekick wants to start a subagent",
      summary: "title: Fix CI · provider: claude · workspaceId: w1",
    });
    expect(describePermission("mcp__paseo__send_agent_prompt", { agentId: "a2", prompt: "line one\n  line two" }).summary).toBe("agentId: a2 · prompt: line one line two");
    expect(describePermission("mcp__paseo__archive_agent", { agentId: "a3" })).toMatchObject({ sentence: "The Sidekick wants to archive an agent", summary: "agentId: a3" });
  });

  it("maps the plugin's tools and the disallowed ones", () => {
    expect(describePermission("mcp__paseo__cancel_run", { runId: "run_1" })).toMatchObject({ sentence: "The Sidekick wants to cancel a run", summary: "runId: run_1" });
    expect(describePermission("mcp__paseo__restart_run", { runId: "run_1" }).sentence).toBe("The Sidekick wants to restart a run");
    expect(describePermission("mcp__paseo__subscribe_events", { events: ["gate.escalated"] }).sentence).toBe("The Sidekick wants to subscribe to run events");
    expect(describePermission("Bash", { command: "rm -rf /tmp/x" })).toMatchObject({ sentence: "The Sidekick wants to run a shell command", summary: "rm -rf /tmp/x" });
    expect(describePermission("Edit", { file_path: "/a/b.ts" }).summary).toBe("file_path: /a/b.ts");
    expect(describePermission("Write", { file_path: "/a/c.ts" }).sentence).toBe("The Sidekick wants to write a file");
  });

  it("falls back to the short tool name", () => {
    expect(describePermission("mcp__paseo__mystery_tool", {})).toEqual({ sentence: "The Sidekick wants to use mystery_tool", summary: null, toolId: "mcp__paseo__mystery_tool" });
    expect(describePermission(undefined, undefined).sentence).toBe("The Sidekick wants to use unknown tool");
    expect(shortToolName("mcp__paseo_playbooks__get_run")).toBe("get_run");
    expect(shortToolName("Bash")).toBe("Bash");
  });
});
