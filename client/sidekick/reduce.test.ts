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

  it("does not show Stopped when the cancel comes from our own steer", () => {
    let state = run([{ type: "event", event: { type: "turn_started" } }, { type: "steer_sent" }]);
    state = reduce(state, { type: "event", event: { type: "turn_canceled" } });
    expect(state.items.filter((item) => item.kind === "notice")).toEqual([]);
    expect(state.steering).toBe(false);
    state = reduce(state, { type: "event", event: { type: "turn_started" } });
    state = reduce(state, { type: "event", event: { type: "turn_canceled" } });
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", text: "Stopped" });
  });

  it("ignores a steer sent while idle", () => {
    expect(reduce(initialState(), { type: "steer_sent" }).steering).toBe(false);
  });
});

describe("sidekick windowed history", () => {
  const win = (hasOlder: boolean, seq = 10, epoch = "e1") => ({ epoch, startCursor: hasOlder ? { epoch, seq } : null, hasOlder });
  const msg = (seq: number, text = `m${seq}`) => ({ key: `seq:${seq}`, item: { type: "assistant_message", text } });
  const keys = (state: ChatState) => state.items.map((item) => item.key);

  it("records where the window starts from the first page", () => {
    const state = run([{ type: "refetch", items: [msg(10), msg(11)], span: win(true) }]);
    expect(state.older).toEqual({ epoch: "e1", cursor: { epoch: "e1", seq: 10 }, hasMore: true, loading: false });
    expect(run([{ type: "refetch", items: [msg(1)], span: win(false, 1) }]).older.hasMore).toBe(false);
  });

  it("prepends an older page in order, moves the cursor and ends at the start", () => {
    let state = run([{ type: "refetch", items: [msg(10), msg(11)], span: win(true) }, { type: "older_start" }]);
    expect(state.older.loading).toBe(true);
    state = reduce(state, { type: "older", items: [msg(5), msg(6)], from: 10, span: win(true, 5) });
    expect(keys(state)).toEqual(["seq:5", "seq:6", "seq:10", "seq:11"]);
    expect(state.older).toMatchObject({ hasMore: true, loading: false, cursor: { seq: 5 } });
    state = run([{ type: "older_start" }, { type: "older", items: [msg(1)], from: 5, span: win(false, 1) }], state);
    expect(keys(state)[0]).toBe("seq:1");
    expect(state.older).toMatchObject({ hasMore: false, cursor: null });
    // Nothing more to read: no new read starts.
    expect(reduce(state, { type: "older_start" }).older.loading).toBe(false);
  });

  it("never reads a page twice: a second start while loading, or a page from an old cursor, changes nothing", () => {
    const base = run([{ type: "refetch", items: [msg(10)], span: win(true) }, { type: "older_start" }]);
    expect(reduce(base, { type: "older_start" })).toBe(base);
    const merged = reduce(base, { type: "older", items: [msg(5)], from: 10, span: win(true, 5) });
    const again = reduce(merged, { type: "older", items: [msg(5), msg(6)], from: 10, span: win(true, 5) });
    expect(keys(again)).toEqual(["seq:5", "seq:10"]);
  });

  it("drops entries already shown and a tool call that the newer page already has", () => {
    const tool = (seq: number, status: "running" | "completed") => ({ key: `seq:${seq}`, item: { type: "tool_call", callId: "c1", name: "Read", status } });
    const base = run([{ type: "refetch", items: [tool(10, "completed"), msg(11)], span: win(true) }]);
    const state = reduce(base, { type: "older", items: [msg(8), tool(9, "running"), msg(11, "again")], from: 10, span: win(false, 8) });
    expect(keys(state)).toEqual(["seq:8", "seq:10", "seq:11"]);
    expect(state.items[2]).toMatchObject({ text: "m11" });
  });

  it("ignores an older page of another epoch", () => {
    const base = run([{ type: "refetch", items: [msg(10)], span: win(true) }]);
    const state = reduce(base, { type: "older", items: [msg(5)], from: 10, span: win(true, 5, "e2") });
    expect(keys(state)).toEqual(["seq:10"]);
  });

  it("a failed read can be tried again", () => {
    const state = run([{ type: "refetch", items: [msg(10)], span: win(true) }, { type: "older_start" }, { type: "older_failed" }]);
    expect(state.older).toMatchObject({ loading: false, hasMore: true });
  });

  it("keeps older pages already read when the tail is re-read, and the live items too", () => {
    let state = run([{ type: "refetch", items: [msg(10), msg(11)], span: win(true) }, { type: "older", items: [msg(5), msg(6)], from: 10, span: win(true, 5) }, timeline({ type: "assistant_message", text: "streaming now" })]);
    state = reduce(state, { type: "refetch", items: [msg(10), msg(11), msg(12)], span: win(true) });
    expect(keys(state)).toEqual(["seq:5", "seq:6", "seq:10", "seq:11", "live:1", "seq:12"]);
    expect(state.older.cursor).toEqual({ epoch: "e1", seq: 5 });
  });

  it("resets cleanly when the tail no longer overlaps what is shown, or the epoch changed", () => {
    const base = run([{ type: "refetch", items: [msg(10), msg(11)], span: win(true) }, { type: "older", items: [msg(5), msg(6)], from: 10, span: win(true, 5) }]);
    const gap = reduce(base, { type: "refetch", items: [msg(30), msg(31)], span: win(true, 30) });
    expect(keys(gap)).toEqual(["seq:30", "seq:31"]);
    expect(gap.older.cursor?.seq).toBe(30);
    const replaced = reduce(base, { type: "refetch", items: [msg(1), msg(2)], span: win(false, 1, "e2") });
    expect(keys(replaced)).toEqual(["seq:1", "seq:2"]);
    expect(replaced.older).toMatchObject({ epoch: "e2", hasMore: false });
  });

  it("keeps the identity of items that did not change, on a re-read and a streaming event", () => {
    const first = run([{ type: "refetch", items: [msg(10), { key: "seq:11", item: { type: "tool_call", callId: "c", name: "Bash", status: "completed", detail: { output: "x" } } }], span: win(true) }]);
    const second = reduce(first, { type: "refetch", items: [msg(10), { key: "seq:11", item: { type: "tool_call", callId: "c", name: "Bash", status: "completed", detail: { output: "x" } } }, msg(12)], span: win(true) });
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).toBe(first.items[1]);
    const done = reduce(first, { type: "refetch", items: [msg(10), { key: "seq:11", item: { type: "tool_call", callId: "c", name: "Bash", status: "failed", detail: { output: "x" } } }], span: win(true) });
    expect(done.items[0]).toBe(first.items[0]);
    expect(done.items[1]).not.toBe(first.items[1]);
    const streaming = run([{ type: "event", event: { type: "turn_started" } }, timeline({ type: "assistant_message", text: "a" })], second);
    const next = reduce(streaming, timeline({ type: "assistant_message", text: "b" }));
    const changedCount = next.items.filter((entry, index) => entry !== streaming.items[index]).length;
    expect(changedCount).toBe(1);
  });
});
