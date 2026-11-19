import { describe, expect, it } from "vitest";
import { CODEX_QUESTION_RULE, withCodexQuestionGuidance } from "./prompts";
import { managerQuestionAnswer, managerQuestionChoices } from "../shared/gates";
import { describeQuestion } from "./permissions";

describe("Codex human question guidance", () => {
  it("makes decision choices, recommendation, and the open-text route explicit for all Codex questions", () => {
    expect(CODEX_QUESTION_RULE).toContain("ordinary clarification questions");
    expect(CODEX_QUESTION_RULE).toContain("options: []");
    expect(CODEX_QUESTION_RULE).toContain("2–3 substantive, distinct choices");
    expect(CODEX_QUESTION_RULE).toContain("(Recommended)");
    expect(CODEX_QUESTION_RULE).toContain("Keep the UI's automatic Other/free-text answer available");
    expect(CODEX_QUESTION_RULE).toContain("keep the question open-text");
    expect(CODEX_QUESTION_RULE).toContain("declared choices");
  });

  it("preserves role instructions and config while adding the question policy", () => {
    const config = { provider: "codex/gpt-5-mini", systemPrompt: "Read-only reviewer.", modeId: "default", thinkingOptionId: "low" };
    expect(withCodexQuestionGuidance(config)).toEqual({ ...config, systemPrompt: `Read-only reviewer.\n\n${CODEX_QUESTION_RULE}` });
    expect(config.systemPrompt).toBe("Read-only reviewer.");
    expect(withCodexQuestionGuidance({ provider: "codex/gpt-5-mini" }).systemPrompt).toBe(CODEX_QUESTION_RULE);
  });

  it.each(["claude/claude-haiku-5-5", "other/model", "codex-like/model"])("leaves %s untouched", (provider) => {
    const config = { provider, systemPrompt: "Existing instructions." };
    expect(withCodexQuestionGuidance(config)).toBe(config);
  });

  it("retains recommended labels and rationale when mirroring a native question", () => {
    const options = [
      { label: "Ship after QA (Recommended)", description: "QA verifies the fix before release." },
      { label: "Defer this release", description: "Wait for the next scheduled release." },
    ];
    const result = describeQuestion({ id: "q", name: "request_user_input", kind: "question", input: { questions: [{ question: "When should we release?", options }] } }, "manager");
    expect(result?.question).toEqual({ text: "When should we release?", options, answerable: true });
    expect(result?.details).toContain("Ship after QA (Recommended): QA verifies the fix before release.");
    const question = result!.question;
    expect(managerQuestionChoices(question).map((choice) => choice.id)).toEqual(["option-1", "option-2", "other"]);
    expect(managerQuestionAnswer(question, "option-1", null)).toBe("Ship after QA (Recommended)");
    expect(managerQuestionAnswer(question, "other", "Release on Monday instead")).toBe("Release on Monday instead");
  });
});
