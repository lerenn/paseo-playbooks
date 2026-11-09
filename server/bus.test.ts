import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { BusError, EventBus, globToRegExp, matchesType, type Notifier, type Subscription } from "./bus";

const dirs: string[] = [];
const buses: EventBus[] = [];
afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBus(options: { capacity?: number; debounceMs?: number } = {}, dir?: string) {
  const root = dir ?? (await mkdtemp(path.join(tmpdir(), "bus-")));
  if (!dir) dirs.push(root);
  const bus = new EventBus({ events: path.join(root, "events.json"), subscriptions: path.join(root, "subs.json") }, { debounceMs: 0, ...options });
  buses.push(bus);
  const delivered: Array<{ target: string; text: string; seqs: number[] }> = [];
  const notifier: Notifier = {
    deliver: async (sub: Subscription, events, text) => {
      if (sub.sink.target === "ghost") return "gone";
      delivered.push({ target: sub.sink.target, text, seqs: events.map((event) => event.seq) });
      return "delivered";
    },
  };
  bus.registerNotifier("agent", notifier);
  bus.register({ type: "a.one", description: "", payload: z.object({ color: z.string(), n: z.number() }), line: (event) => `- a.one ${event.payload.color}` });
  bus.register({ type: "a.two", description: "", payload: z.object({ color: z.string() }), line: (event) => `- a.two ${event.payload.color}` });
  bus.register({ type: "b.one", description: "", payload: z.object({ color: z.string() }), line: (event) => `- b.one ${event.payload.color}` });
  return { bus, delivered, root };
}
const sink = (target: string) => ({ kind: "agent", target });
const meta = { source: "test" };

describe("type globs", () => {
  it("match exact names, prefixes and everything; dots are literal", () => {
    expect(matchesType(["gate.*"], "gate.opened")).toBe(true);
    expect(matchesType(["gate.*"], "run.failed")).toBe(false);
    expect(matchesType(["run.failed"], "run.failed")).toBe(true);
    expect(matchesType(["run.failed"], "runXfailed")).toBe(false);
    expect(matchesType(["*"], "anything.at.all")).toBe(true);
    expect(matchesType(["*.opened", "run.failed"], "gate.opened")).toBe(true);
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
  });
});

describe("subscriptions and filters", () => {
  it("route by type glob and payload equality; a bad type or filter key is refused with what is known", async () => {
    const { bus, delivered } = await makeBus();
    await bus.subscribe("x", sink("x"), ["a.*"], { color: "red" });
    await bus.subscribe("y", sink("y"), ["*"]);
    await bus.emit("a.one", { color: "red", n: 1 }, meta);
    await bus.emit("a.two", { color: "blue" }, meta);
    await bus.emit("b.one", { color: "red" }, meta);
    await bus.flush();
    expect(delivered.find((entry) => entry.target === "x")!.seqs).toEqual([1]);
    expect(delivered.find((entry) => entry.target === "y")!.seqs).toEqual([1, 2, 3]);

    await expect(bus.subscribe("x", sink("x"), ["nope.*"])).rejects.toThrow(/no event type matches "nope\.\*" \(known: a\.one, a\.two, b\.one\)/);
    await expect(bus.subscribe("x", sink("x"), ["a.two"], { n: 1 })).rejects.toThrow(/filter "n" is not a field of a\.two \(fields: color\)/);
    await expect(bus.subscribe("x", sink("x"), ["a.*"], { n: 1 })).resolves.toBeDefined();
    await expect(bus.subscribe("x", { kind: "slack", target: "c" }, ["a.*"])).rejects.toThrow(BusError);
  });

  it("never tells an actor about its own event", async () => {
    const { bus, delivered } = await makeBus();
    await bus.subscribe("me", sink("me"), ["a.*"]);
    await bus.subscribe("other", sink("other"), ["a.*"]);
    await bus.emit("a.two", { color: "red" }, { ...meta, actors: ["me"] });
    await bus.flush();
    expect(delivered.map((entry) => entry.target)).toEqual(["other"]);
  });

  it("rejects a payload that does not fit its type, and an unknown type", async () => {
    const { bus } = await makeBus();
    await expect(bus.emit("a.one", { color: 3 }, meta)).rejects.toThrow(/bad payload for a\.one: color/);
    await expect(bus.emit("zzz.one", {}, meta)).rejects.toThrow(/unknown event type/);
  });
});

describe("delivery", () => {
  it("coalesces a burst per subscription after the debounce, and a notifier that reports gone drops the subscriptions", async () => {
    const { bus, delivered } = await makeBus({ debounceMs: 5000 });
    await bus.subscribe("x", sink("x"), ["a.*"]);
    await bus.subscribe("ghost", sink("ghost"), ["a.*"]);
    const t = Date.now();
    await bus.emit("a.two", { color: "red" }, meta);
    await bus.emit("a.two", { color: "blue" }, meta);
    await bus.flush(t + 1000);
    expect(delivered).toHaveLength(0);
    await bus.flush(t + 6000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/2 events[\s\S]*a\.two red[\s\S]*a\.two blue[\s\S]*list_events \{ since: 2 \}/);
    expect(await bus.list("ghost")).toEqual([]);
    expect(await bus.list("x")).toHaveLength(1);
  });
});

describe("the recent log", () => {
  it("numbers events monotonically, filters, catches up from a seq, and survives a restart", async () => {
    const first = await makeBus();
    for (const n of [1, 2, 3]) await first.bus.emit("a.one", { color: "red", n }, { ...meta, runId: "r1" });
    await first.bus.emit("b.one", { color: "red" }, meta);
    const all = await first.bus.recent();
    expect(all.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(all.lastSeq).toBe(4);
    expect(all.events[0]).toMatchObject({ id: "evt-1", type: "a.one", runId: "r1", source: "test", payload: { color: "red", n: 1 } });
    expect((await first.bus.recent({ since: 2 })).events.map((event) => event.seq)).toEqual([3, 4]);
    expect((await first.bus.recent({ types: ["b.*"] })).events.map((event) => event.seq)).toEqual([4]);
    expect((await first.bus.recent({ limit: 2 })).events.map((event) => event.seq)).toEqual([3, 4]);
    expect((await first.bus.recent({ since: 0, limit: 2 })).events.map((event) => event.seq)).toEqual([1, 2]);
    await first.bus.close();

    const again = await makeBus({}, first.root);
    expect((await again.bus.recent({ since: 3 })).events.map((event) => event.seq)).toEqual([4]);
    expect((await again.bus.emit("a.two", { color: "x" }, meta)).seq).toBe(5);
  });

  it("is a ring buffer: the oldest events drop, and oldestSeq says so", async () => {
    const { bus } = await makeBus({ capacity: 3 });
    for (let n = 1; n <= 5; n++) await bus.emit("a.two", { color: String(n) }, meta);
    const result = await bus.recent({ since: 0 });
    expect(result.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(result.oldestSeq).toBe(3);
    expect(result.lastSeq).toBe(5);
  });
});

describe("extensibility", () => {
  it("a new event type, with its own sink, needs no change to the bus or to subscriptions", async () => {
    const { bus } = await makeBus();
    const hooks: string[] = [];
    bus.registerNotifier("webhook", { deliver: async (sub, _events, text) => (hooks.push(`${sub.sink.target}: ${text.split("\n")[1]}`), "delivered") });
    bus.register({ type: "deploy.finished", description: "A deploy ended", payload: z.object({ service: z.string(), ok: z.boolean() }), line: (event) => `- deploy.finished ${event.payload.service} ok=${event.payload.ok}` });
    await bus.subscribe("watcher", { kind: "webhook", target: "https://example.test/hook" }, ["deploy.*"], { ok: false });
    await bus.emit("deploy.finished", { service: "api", ok: true }, meta);
    await bus.emit("deploy.finished", { service: "web", ok: false }, meta);
    await bus.flush();
    expect(hooks).toEqual(["https://example.test/hook: - deploy.finished web ok=false"]);
    expect((await bus.recent({ types: ["deploy.*"] })).events).toHaveLength(2);
  });

  it("a threshold type fires for the delays subscribers asked for, default included", async () => {
    const { bus, delivered } = await makeBus();
    bus.register({ type: "job.slow", description: "", payload: z.object({ thresholdMinutes: z.number() }), threshold: { default: 30 }, line: (event) => `- job.slow ${event.payload.thresholdMinutes}` });
    await bus.subscribe("a", sink("a"), ["job.slow"]);
    await bus.subscribe("b", sink("b"), ["job.slow"], { olderThanMinutes: 5 });
    expect(await bus.thresholds("job.slow")).toEqual([5, 30]);
    for (const thresholdMinutes of [5, 30]) await bus.emit("job.slow", { thresholdMinutes }, meta);
    await bus.flush();
    expect(delivered.find((entry) => entry.target === "a")!.seqs).toEqual([2]);
    expect(delivered.find((entry) => entry.target === "b")!.seqs).toEqual([1]);
  });
});
