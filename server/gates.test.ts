import path from "node:path";
import { describe, expect, it } from "vitest";
import { destinationOf, gateText, linkify } from "../shared/gates";
import { loadPlaybooks } from "./loader";

describe("destinationOf", () => {
  it("shows where each gate choice leads", async () => {
    const result = await loadPlaybooks(path.resolve(__dirname, "..", "examples"));
    const playbook = result.entries.find((entry) => entry.id === "capability")!.playbook!;
    const gate = playbook.steps.find((step) => step.id === "approve")!;
    expect(destinationOf(playbook, gate, "approved")).toEqual({ kind: "next", targets: ["release.release"] });
    expect(destinationOf(playbook, gate, "rejected")).toEqual({ kind: "goto", targets: ["pr.investigate"] });
    const qa = playbook.steps.find((step) => step.id === "release.qa")!;
    expect(destinationOf(playbook, qa, "success")).toEqual({ kind: "end", targets: [] });
  });
});

describe("gateText and linkify", () => {
  const long =
    'PR #3 (https://github.com/lerenn/paseo-playbooks/pull/3, head 61be527) adds a "Known limits" section to README.md and targets feat/playbooks-plugin. Only README.md changed. CI is green.';
  const gate = {
    id: "g", kind: "gate" as const, stepId: "pr_approval", gotoTarget: null, status: "pending",
    message: "", summary: long, details: "The PR is ready.", requestedAt: "", comment: null, decidedBy: null, decidedVia: null, decidedAt: null,
  };

  it("keeps the first sentence as the summary and moves the rest to details", () => {
    const text = gateText(gate);
    expect(text.summary).toBe('PR #3 (https://github.com/lerenn/paseo-playbooks/pull/3, head 61be527) adds a "Known limits" section to README.md and targets feat/playbooks-plugin.');
    expect(text.details).toBe("Only README.md changed. CI is green.\n\nThe PR is ready.");
  });

  it("turns bare URLs into autolinks, without touching existing links or trailing punctuation", () => {
    expect(linkify("PR #3 (https://github.com/o/r/pull/3, head x).")).toBe("PR #3 (<https://github.com/o/r/pull/3>, head x).");
    expect(linkify("See https://example.com/a.")).toBe("See <https://example.com/a>.");
    expect(linkify("[PR](https://github.com/o/r/pull/3) and <https://x.y/z>")).toBe("[PR](https://github.com/o/r/pull/3) and <https://x.y/z>");
  });
});
