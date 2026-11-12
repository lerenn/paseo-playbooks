import { describe, expect, it } from "vitest";
import { sanitizeWorkspaceName, workspaceTitle, WORKSPACE_NAME_MAX } from "./workspace-name";

describe("sanitizeWorkspaceName", () => {
  it("trims and collapses whitespace and control characters", () => {
    expect(sanitizeWorkspaceName("  fix \n\t the   login\u0000 ")).toBe("fix the login");
  });
  it("is undefined when empty", () => {
    expect(sanitizeWorkspaceName("   \n")).toBeUndefined();
    expect(sanitizeWorkspaceName(undefined)).toBeUndefined();
  });
  it("caps the length without leaving a trailing space", () => {
    const name = sanitizeWorkspaceName(`${"a".repeat(WORKSPACE_NAME_MAX - 1)} bbbb`)!;
    expect(name.length).toBeLessThanOrEqual(WORKSPACE_NAME_MAX);
    expect(name.endsWith(" ")).toBe(false);
  });
  it("keeps branch-hostile characters: the branch never uses the title", () => {
    expect(sanitizeWorkspaceName("a/b: c..d")).toBe("a/b: c..d");
  });
});

describe("workspaceTitle", () => {
  it("defaults to the playbook title and the request headline", () => {
    expect(workspaceTitle("Fix", { request: "login" })).toBe("Fix: login");
    expect(workspaceTitle("Fix", {})).toBe("Fix");
    expect(workspaceTitle("Fix", { request: "x".repeat(100) }, "  ")).toBe(`Fix: ${"x".repeat(60)}`);
  });
  it("uses the chosen name", () => {
    expect(workspaceTitle("Fix", { request: "login" }, " My ws ")).toBe("My ws");
  });
});
