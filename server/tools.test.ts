import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { defaultRunToCancel } from "./tools";

/** Only the fields defaultRunToCancel reads. */
function run(id: string, managerAgentId: string, workspaceId: string, status: Run["status"] = "running"): Run {
  return { id, managerAgentId, workspaceId, status, after: {}, branch: `b-${id}`, workspaceDir: `/w/${id}`, playbook: { id: "pr" } } as unknown as Run;
}

describe("defaultRunToCancel", () => {
  it("picks the caller's own active run first", () => {
    const runs = [run("a", "other", "ws1"), run("b", "me", "ws2")];
    expect(defaultRunToCancel(runs, "me", "ws1").id).toBe("b");
  });

  it("falls back to the only active run of the caller's workspace", () => {
    const runs = [run("a", "m1", "ws1", "completed"), run("b", "m2", "ws1"), run("c", "m3", "ws2")];
    expect(defaultRunToCancel(runs, "me", "ws1").id).toBe("b");
  });

  it("asks for a runId when it cannot choose", () => {
    expect(() => defaultRunToCancel([run("a", "m1", "ws1"), run("b", "m2", "ws1")], "me", "ws1")).toThrow(/several runs.*a, b/);
    expect(() => defaultRunToCancel([run("a", "m1", "ws2")], "me", "ws1")).toThrow(/pass runId.*a \(pr, b-a\)/);
    expect(() => defaultRunToCancel([run("a", "m1", "ws1", "canceled")], "me", "ws1")).toThrow(/no run is active/);
  });
});
