import { describe, expect, it } from "vitest";
import { sanitizeWorkspaceName, workspaceTitle, workspaceTitleRefs, WORKSPACE_NAME_MAX } from "./workspace-name";

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
  describe("workspace.title template", () => {
    it("fills {input} from the inputs", () => {
      expect(workspaceTitle("Ship it", { ticket: "OPS-1" }, undefined, "Ship {ticket}")).toBe("Ship OPS-1");
      expect(workspaceTitle("P", { a: "x", n: 3 }, null, "{a}/{n}")).toBe("x/3");
    });
    it("an explicit name wins over the template", () => {
      expect(workspaceTitle("Ship it", { ticket: "OPS-1" }, "Mine", "Ship {ticket}")).toBe("Mine");
    });
    it("keeps the default title when an input is missing or empty", () => {
      expect(workspaceTitle("Ship it", { ticket: "OPS-1" }, undefined, "Ship {nope}")).toBe("Ship it: OPS-1");
      expect(workspaceTitle("Ship it", { ticket: "" }, undefined, "Ship {ticket}")).toBe("Ship it");
      expect(workspaceTitle("Ship it", { ticket: "T", other: "" }, undefined, "{ticket} {other}")).toBe("Ship it: T");
    });
    it("trims to one line of at most 80 characters", () => {
      const title = workspaceTitle("P", { a: `x\ny ${"z".repeat(200)}` }, undefined, "Ship {a}");
      expect(title).toHaveLength(80);
      expect(title).not.toMatch(/\n/);
      expect(title.startsWith("Ship x y z")).toBe(true);
    });
    it("lists the placeholders", () => {
      expect(workspaceTitleRefs("a {x} {{ y }} {z-1}")).toEqual(["x", "z-1"]);
    });
  });
});
