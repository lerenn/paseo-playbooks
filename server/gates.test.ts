import path from "node:path";
import { describe, expect, it } from "vitest";
import { destinationOf } from "../shared/gates";
import { loadPlaybooks } from "./loader";

describe("destinationOf", () => {
  it("shows where each gate choice leads", async () => {
    const result = await loadPlaybooks(path.resolve(__dirname, "..", "examples"), { allowedModes: { claude: ["default", "bypassPermissions"] } });
    const playbook = result.entries.find((entry) => entry.id === "pr")!.playbook!;
    const gate = playbook.steps.find((step) => step.id === "pr_approval")!;
    expect(destinationOf(playbook, gate, "approved")).toEqual({ kind: "end", targets: [] });
    expect(destinationOf(playbook, gate, "rejected")).toEqual({ kind: "goto", targets: ["implement"] });
    const review = playbook.steps.find((step) => step.id === "implement")!;
    expect(destinationOf(playbook, review, "success").kind).toBe("next");
  });
});
