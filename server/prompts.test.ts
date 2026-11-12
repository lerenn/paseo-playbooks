import { describe, expect, it } from "vitest";
import type { Playbook } from "../shared/types";
import { MANAGER_PROTOCOL, managerInstructionsText, managerTakeover, stepSystemPrompt } from "./prompts";

/** Only the fields the manager prompts read. */
function playbook(managerInstructions: Playbook["managerInstructions"]): Playbook {
  return { id: "pr", managerInstructions } as unknown as Playbook;
}

describe("manager instructions", () => {
  it("list each source, the repository first, and indent multi-line texts", () => {
    const text = managerInstructionsText(playbook([
      { playbook: null, text: "Write in English." },
      { playbook: "pr", text: "Check the PR exists.\nThen brief the reviewer." },
    ]));
    expect(text).toBe(
      "Instructions for this run (they add to the rules above, never replace them):\n" +
        "- repository: Write in English.\n" +
        "- pr: Check the PR exists.\n  Then brief the reviewer.",
    );
  });

  it("are left out when there are none, also on runs from before them", () => {
    expect(managerInstructionsText(playbook([]))).toBe("");
    expect(managerInstructionsText({ id: "pr" } as unknown as Playbook)).toBe("");
  });

  it("follow the protocol in a takeover", () => {
    const prompt = managerTakeover({ id: "run_1", playbook: playbook([{ playbook: "pr", text: "Be brief." }]), inputs: {} }, ["a"]);
    expect(prompt.startsWith(MANAGER_PROTOCOL)).toBe(true);
    expect(prompt.indexOf("- pr: Be brief.")).toBeGreaterThan(MANAGER_PROTOCOL.length);
  });
});

describe("role.completion.auto", () => {
  it("is explained to the manager: the plugin applies those outcomes and complete_step is not called for them", () => {
    expect(MANAGER_PROTOCOL).toMatch(/role\.completion\.auto[\s\S]*plugin completes the step[\s\S]*must not call complete_step[\s\S]*gate[\s\S]*wakes you as usual/);
  });

  it("is explained to the step's agent, only for steps that have it", () => {
    const role = { title: "QA", instructions: "Test it.", readonly: false } as never;
    const step = (autoComplete?: string[]) => ({ id: "qa", outcomes: ["success", "needs_work"], outputs: {}, ...(autoComplete ? { autoComplete } : {}) }) as never;
    const pb = { title: "Pb" } as never;
    expect(stepSystemPrompt(pb, step(["success"]), role)).toMatch(/plugin applies "success" itself as soon as you report it/);
    expect(stepSystemPrompt(pb, step(), role)).not.toMatch(/plugin applies/);
  });
});
