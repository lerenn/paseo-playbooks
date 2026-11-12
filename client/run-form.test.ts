import { describe, expect, it } from "vitest";
import type { Playbook, PlaybookEntry } from "../shared/types";
import { defaultProject, inputErrors, projectsOf, runButtonState, runnablePlaybooks } from "./run-form";

const pb = (inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "p", title: "P", inputs, ...extra }) as unknown as Playbook;
const entry = (id: string, playbook: Playbook | null, errors: string[] = []) => ({ id, playbook, errors }) as unknown as PlaybookEntry;

describe("runnablePlaybooks", () => {
  it("keeps valid non-singleton playbooks", () => {
    const ok = pb({});
    const singleton = pb({}, { singleton: { branch: "main" } });
    expect(runnablePlaybooks([entry("a", ok), entry("b", null, ["bad"]), entry("c", singleton), entry("d", ok, ["warn"])])).toEqual([ok]);
  });
});

describe("inputErrors", () => {
  const playbook = pb({ request: { type: "string", required: true }, n: { type: "number" }, d: { type: "string", required: true, default: "x" }, b: { type: "boolean", required: true } });
  it("flags a missing required input and a bad number", () => {
    expect(inputErrors(playbook, { request: "  ", n: "abc", d: "", b: false })).toEqual({ request: "Required", n: "Must be a number" });
  });
  it("accepts valid values", () => {
    expect(inputErrors(playbook, { request: "go", n: "3", d: "", b: false })).toEqual({});
  });
});

describe("projectsOf", () => {
  it("keeps the first workspace of each project, sorted by label", () => {
    const ws = (id: string, projectId: string, projectLabel: string) => ({ id, projectId, projectLabel });
    expect(projectsOf([ws("w1", "b", "Beta"), ws("w2", "a", "Alpha"), ws("w3", "b", "Beta")])).toEqual([
      { projectId: "a", label: "Alpha", workspaceId: "w2" },
      { projectId: "b", label: "Beta", workspaceId: "w1" },
    ]);
  });
});

describe("defaultProject", () => {
  const candidates = [
    { projectId: "a", label: "A", workspaceId: "w1" },
    { projectId: "b", label: "B", workspaceId: "w2" },
  ];
  it("preselects the chip's project, else the only candidate, else none", () => {
    expect(defaultProject(candidates, "b")).toBe("b");
    expect(defaultProject(candidates, "zzz")).toBeNull();
    expect(defaultProject(candidates, null)).toBeNull();
    expect(defaultProject(candidates.slice(0, 1), null)).toBe("a");
  });
});

describe("runButtonState", () => {
  it("is disabled while loading rather than hidden, so it does not appear late", () => {
    expect(runButtonState(0, true)).toBe("loading");
    expect(runButtonState(0, false)).toBe("hidden");
    expect(runButtonState(2, true)).toBe("ready");
  });
});
