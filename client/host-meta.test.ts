import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_META_VISIBILITY, hasLeadingHostItem } from "./host-meta";

const SHOWN = { ...DEFAULT_HOST_META_VISIBILITY, branch: true, project: true };

describe("hasLeadingHostItem", () => {
  it("is false when the host draws nothing before our badges", () => {
    expect(hasLeadingHostItem({})).toBe(false);
    expect(hasLeadingHostItem({ branch: null, projectName: null, labels: [] })).toBe(false);
  });
  it("hides the dot for a branch and a project under the default Show menu (both off)", () => {
    expect(hasLeadingHostItem({ branch: "main", projectName: "repo" })).toBe(false);
  });
  it("counts a branch only, once the Show menu shows branches", () => {
    expect(hasLeadingHostItem({ branch: "main" }, SHOWN)).toBe(true);
    expect(hasLeadingHostItem({ branch: null }, SHOWN)).toBe(false);
    expect(hasLeadingHostItem({ branch: "main" }, { ...SHOWN, branch: false })).toBe(false);
  });
  it("counts a project only, once the Show menu shows projects", () => {
    expect(hasLeadingHostItem({ projectName: "repo" }, SHOWN)).toBe(true);
    expect(hasLeadingHostItem({ projectName: "repo" }, { ...SHOWN, project: false })).toBe(false);
  });
  it("counts a pull request, which the checks item can keep alone when the pull request item is hidden", () => {
    expect(hasLeadingHostItem({ hasPullRequest: true })).toBe(true);
    expect(hasLeadingHostItem({ hasPullRequest: true }, { ...SHOWN, changeRequest: false })).toBe(true);
    expect(hasLeadingHostItem({ hasPullRequest: true }, { ...SHOWN, changeRequest: false, checks: false })).toBe(false);
  });
  it("counts labels, unless hidden", () => {
    expect(hasLeadingHostItem({ labels: ["a"] })).toBe(true);
    expect(hasLeadingHostItem({ labels: ["a"] }, { ...SHOWN, labels: false })).toBe(false);
  });
  it("counts the host badge and a running service", () => {
    expect(hasLeadingHostItem({ hasHostBadge: true })).toBe(true);
    expect(hasLeadingHostItem({ hasService: true })).toBe(true);
    expect(hasLeadingHostItem({ hasService: true }, { ...SHOWN, services: false })).toBe(false);
  });
});
