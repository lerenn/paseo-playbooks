import { describe, expect, it } from "vitest";
import { conversationText } from "./conversation";

const options = { includeReasoning: false, includeToolDetail: false, maxChars: 50 };

describe("conversationText", () => {
  const entries = [
    { item: { type: "user_message", text: "Do it" } },
    { item: { type: "reasoning", text: "hmm" } },
    { item: { type: "assistant_message", text: "On " } },
    { item: { type: "assistant_message", text: "it." } },
    { item: { type: "tool_call", name: "Bash", status: "failed", error: { message: "exit 1" }, detail: { command: "ls" } } },
  ];

  it("merges streamed deltas, drops reasoning and shows tool failures", () => {
    expect(conversationText(entries, options)).toBe("user: Do it\nassistant: On it.\ntool: Bash (failed) — exit 1");
  });

  it("keeps reasoning and tool input when asked, and clips long text", () => {
    const text = conversationText([...entries, { item: { type: "assistant_message", text: "x".repeat(80) } }], { ...options, includeReasoning: true, includeToolDetail: true });
    expect(text).toContain("thought: hmm");
    expect(text).toContain('{"command":"ls"}');
    expect(text).toContain("[30 more characters]");
  });
});
