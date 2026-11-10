import { describe, expect, it } from "vitest";
import { groupLabel, groupTools } from "./group";
import { initialState, reduce } from "./reduce";
import type { Item } from "./reduce";

const tool = (n: number, name: string, status: "running" | "completed" | "failed" = "completed"): Item => ({ kind: "tool", key: `t${n}`, callId: `c${n}`, name, status, detail: null, error: null });
const say = (key: string): Item => ({ kind: "assistant", key, text: "hi", streaming: false });

describe("groupTools", () => {
  it("collapses consecutive tool calls and keeps messages between groups", () => {
    const view = groupTools([say("a"), tool(1, "mcp__paseo__list_runs"), tool(2, "mcp__paseo__get_run"), tool(3, "mcp__paseo__get_run"), say("b"), tool(4, "mcp__paseo__list_gates")]);
    expect(view.map((entry) => entry.kind)).toEqual(["item", "tools", "item", "tools"]);
    expect(view[1]).toMatchObject({ label: "Checked list_runs, get_run (3)", state: "completed" });
    expect(view[3]).toMatchObject({ label: "Checked list_gates (1)" });
  });

  it("shows a failed call first, then a running one", () => {
    expect(groupTools([tool(1, "a"), tool(2, "b", "running")])[0]).toMatchObject({ state: "running" });
    expect(groupTools([tool(1, "a", "failed"), tool(2, "b", "running")])[0]).toMatchObject({ state: "failed" });
  });

  it("shortens a long list of names", () => {
    expect(groupLabel(["a", "b", "c", "d"].map((name, i) => tool(i, name)) as never)).toBe("Checked a, b, c, … (4)");
  });
});

describe("the instructions message", () => {
  const prompt = 'You are the Playbooks Sidekick of the project "Shop" (/x): a coordinator.';
  it("is marked when it is the first user message and starts with the prompt", () => {
    const state = reduce(initialState(), { type: "refetch", items: [{ key: "seq:1", item: { type: "user_message", text: prompt } }, { key: "seq:2", item: { type: "user_message", text: "hello" } }] });
    expect(state.items).toMatchObject([{ instructions: true }, {}]);
    expect((state.items[1] as { instructions?: boolean }).instructions).toBeUndefined();
  });
  it("leaves a human message alone", () => {
    const state = reduce(initialState(), { type: "refetch", items: [{ key: "seq:1", item: { type: "user_message", text: "hello" } }] });
    expect((state.items[0] as { instructions?: boolean }).instructions).toBeUndefined();
  });
});
