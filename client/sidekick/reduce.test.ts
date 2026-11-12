import { describe, expect, it } from "vitest";
import { initialState, reduce, type ChatAction, type ChatState } from "./reduce";

const run = (actions: ChatAction[], from: ChatState = initialState()) => actions.reduce(reduce, from);
const timeline = (item: Record<string, unknown>): ChatAction => ({ type: "event", event: { type: "timeline", item: item as never } });

describe("sidekick chat reducer", () => {
  it("reads a page into items, keeping the last status of a tool call", () => {
    const state = run([
      {
        type: "refetch",
        items: [
          { key: "seq:1", item: { type: "user_message", text: "hi" } },
          { key: "seq:2", item: { type: "tool_call", callId: "c1", name: "list_gates", status: "running" } },
          { key: "seq:3", item: { type: "tool_call", callId: "c1", name: "list_gates", status: "completed" } },
          { key: "seq:4", item: { type: "assistant_message", text: "done" } },
          { key: "seq:5", item: { type: "todo" } },
        ],
      },
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
    expect(state.items[1]).toMatchObject({ status: "completed" });
  });

  it("appends live assistant chunks to one streaming message and closes it when the turn ends", () => {
    const state = run([{ type: "event", event: { type: "turn_started" } }, timeline({ type: "assistant_message", text: "Hel" }), timeline({ type: "assistant_message", text: "lo" })]);
    expect(state.running).toBe(true);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    const done = reduce(state, { type: "event", event: { type: "turn_completed" } });
    expect(done.running).toBe(false);
    expect(done.items[0]).toMatchObject({ streaming: false });
  });

  it("updates a tool card in place and starts a new message after a tool", () => {
    const state = run([
      timeline({ type: "assistant_message", text: "Checking" }),
      timeline({ type: "tool_call", callId: "c1", name: "get_run", status: "running" }),
      timeline({ type: "tool_call", callId: "c1", name: "get_run", status: "completed" }),
      timeline({ type: "assistant_message", text: "Ok" }),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(state.items[1]).toMatchObject({ status: "completed" });
    expect(state.items[0]).toMatchObject({ streaming: false, text: "Checking" });
  });

  it("tracks permission requests until they are resolved", () => {
    let state = run([{ type: "event", event: { type: "permission_requested", request: { id: "p1", title: "Run" } } }]);
    expect(state.permissions.map((entry) => entry.id)).toEqual(["p1"]);
    state = reduce(state, { type: "event", event: { type: "permission_requested", request: { id: "p1", title: "Run again" } } });
    expect(state.permissions).toHaveLength(1);
    state = reduce(state, { type: "permission_resolved", requestId: "p1" });
    expect(state.permissions).toEqual([]);
  });

  it("shows failures and stops as notices and clears the running flag", () => {
    const failed = run([{ type: "event", event: { type: "turn_started" } }, { type: "event", event: { type: "turn_failed", error: "boom" } }]);
    expect(failed.running).toBe(false);
    expect(failed.items[0]).toMatchObject({ kind: "notice", level: "error", text: "boom" });
    const stopped = reduce(failed, { type: "event", event: { type: "turn_canceled" } });
    expect(stopped.items[1]).toMatchObject({ kind: "notice", text: "Stopped" });
  });

  it("takes running and permissions from a snapshot", () => {
    const state = run([{ type: "snapshot", running: true, permissions: [{ id: "p9" }] }]);
    expect(state.running).toBe(true);
    expect(state.permissions[0]!.id).toBe("p9");
  });

  it("keeps live tool calls that a later page does not list", () => {
    let state = reduce(initialState(), timeline({ type: "assistant_message", text: "Checking" }));
    state = reduce(state, timeline({ type: "tool_call", callId: "c1", name: "get_run", status: "completed" }));
    state = reduce(state, timeline({ type: "assistant_message", text: "Done" }));
    state = reduce(state, { type: "refetch", items: [{ key: "seq:1", item: { type: "assistant_message", text: "Checking" } }, { key: "seq:2", item: { type: "assistant_message", text: "Done" } }] });
    expect(state.items.map((item) => item.kind)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("keeps a live notice and an unlisted message when a page replaces the items", () => {
    let state = reduce(initialState(), timeline({ type: "assistant_message", text: "Checking" }));
    state = reduce(state, { type: "event", event: { type: "turn_canceled" } });
    state = reduce(state, timeline({ type: "assistant_message", text: "Later" }));
    state = reduce(state, { type: "refetch", items: [{ key: "seq:1", item: { type: "assistant_message", text: "Checking" } }] });
    expect(state.items.map((item) => item.kind)).toEqual(["assistant", "notice", "assistant"]);
  });
});
