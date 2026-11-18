import { describe, expect, it } from "vitest";
import type { Playbook } from "../shared/types";
import { MANAGER_PROTOCOL, agentRulesText, gateDeciderSystemPrompt, managerAddedText, managerInstructionsText, managerTakeover, stepSystemPrompt } from "./prompts";

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

describe("agent_rules", () => {
  const role = { title: "QA", instructions: "Test it.", readonly: false } as never;
  const step = { id: "qa", outcomes: ["success", "failure"], outputs: {} } as never;
  const withRules = (agentRules?: string[]) => ({ id: "pr", title: "Pb", managerInstructions: [], ...(agentRules ? { agentRules } : {}) }) as unknown as Playbook;

  it("make a Rules section, one line per rule", () => {
    expect(agentRulesText(withRules(["One.", "Two\nlines."]))).toMatch(/^Rules \(house rules[^\n]*\):\n- One\.\n- Two\n {2}lines\.$/);
    expect(agentRulesText(withRules([]))).toBe("");
    expect(agentRulesText(withRules())).toBe("");
  });

  it("are in a step agent's prompt, after the command rule and before the step protocol", () => {
    const prompt = stepSystemPrompt(withRules(["Prefer simple commands."]), step, role);
    const rules = prompt.indexOf("- Prefer simple commands.");
    expect(rules).toBeGreaterThan(prompt.indexOf("Compound or destructive-looking"));
    expect(rules).toBeLessThan(prompt.indexOf('You are running step "qa"'));
  });

  it("leave a step prompt byte-identical when there are none", () => {
    expect(stepSystemPrompt(withRules([]), step, role)).toBe(stepSystemPrompt(withRules(), step, role));
    expect(stepSystemPrompt(withRules(), step, role)).not.toMatch(/Rules \(/);
    expect(stepSystemPrompt(withRules(), step, role)).toMatch(/Compound or destructive-looking commands can raise a permission request that stalls the run\.\n\nYou are running step/);
  });

  it("are in a role decider's prompt", () => {
    const gate = { id: "g", stepId: "s" } as never;
    expect(gateDeciderSystemPrompt(withRules(["R1."]), gate, role, [])).toMatch(/Test it\.\n\nRules \([^\n]*\):\n- R1\.\n\nThis role is READONLY/);
    expect(gateDeciderSystemPrompt(withRules(), gate, role, [])).not.toMatch(/Rules \(/);
  });

  it("follow the manager's instructions for the manager, also in a takeover", () => {
    const pb = { ...withRules(["R1."]), managerInstructions: [{ playbook: "pr", text: "Be brief." }] } as Playbook;
    const added = managerAddedText(pb);
    expect(added.indexOf("- pr: Be brief.")).toBeLessThan(added.indexOf("- R1."));
    const prompt = managerTakeover({ id: "run_1", playbook: pb, inputs: {} }, ["a"]);
    expect(prompt).toContain("- R1.");
    expect(managerAddedText(withRules())).toBe("");
    expect(managerTakeover({ id: "run_1", playbook: withRules(), inputs: {} }, ["a"])).not.toMatch(/Rules \(/);
  });
});
