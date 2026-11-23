import { describe, expect, it } from "vitest";
import { isQueueKey, mergeQueued, queueAction, shouldFlush } from "./queue";

describe("queued message", () => {
  it("queues on Meta/Ctrl+Enter only", () => {
    expect(isQueueKey({ key: "Enter", metaKey: true })).toBe(true);
    expect(isQueueKey({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isQueueKey({ key: "Enter" })).toBe(false);
    expect(isQueueKey({ key: "a", metaKey: true })).toBe(false);
    expect(isQueueKey({ key: "Enter", metaKey: true, shiftKey: true })).toBe(false);
  });
  it("sends at once when idle, queues when running", () => {
    expect(queueAction(false)).toBe("send");
    expect(queueAction(true)).toBe("queue");
  });
  it("flushes only a queued message on a live, idle, not-sending chat", () => {
    const q = { text: "x", attachments: [] };
    expect(shouldFlush(q, { live: true, running: false, sending: false })).toBe(true);
    expect(shouldFlush(q, { live: true, running: true, sending: false })).toBe(false);
    expect(shouldFlush(q, { live: false, running: false, sending: false })).toBe(false);
    expect(shouldFlush(q, { live: true, running: false, sending: true })).toBe(false);
    expect(shouldFlush(undefined, { live: true, running: false, sending: false })).toBe(false);
  });
  it("merges successive queued messages", () => {
    const a = { text: "one", attachments: [] };
    expect(mergeQueued(undefined, a)).toBe(a);
    expect(mergeQueued(a, { text: "two", attachments: [] }).text).toBe("one\n\ntwo");
  });
});

describe("while the conversation is compacted", () => {
  it("queues every message (even a plain Enter) and says it is compacting", async () => {
    const { shouldQueue, workLabel } = await import("./queue");
    const { PluginTranslationRuntime } = await import("@getpaseo/plugin/client/host");
    const { messages } = await import("../i18n");
    const runtime = new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} });
    const label = (key: "sidekick.chat.compacting" | "sidekick.chat.working") => runtime.t(messages, key) as string;
    expect(shouldQueue(false, { running: true, compacting: false })).toBe(false);
    expect(shouldQueue(true, { running: true, compacting: false })).toBe(true);
    expect(shouldQueue(false, { running: true, compacting: true })).toBe(true);
    expect(shouldQueue(true, { running: false, compacting: false })).toBe(false);
    expect(workLabel(label, { running: true, compacting: true })).toMatch(/^Compacting/);
    expect(workLabel(label, { running: true, compacting: false })).toBe("Working…");
    expect(workLabel(label, { running: false, compacting: false })).toBeNull();
  });
});
