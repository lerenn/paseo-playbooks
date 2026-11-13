import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newRun } from "./engine";
import { EventBus } from "./bus";
import { OversightProducer } from "./oversight-events";
import { RunStore } from "./store";
import { UsageLedger } from "./usage-ledger";
import { loadPlaybooks } from "./loader";
import { cp, mkdir } from "node:fs/promises";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tmp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coalesce-"));
  dirs.push(dir);
  return dir;
};
let playbook: Awaited<ReturnType<typeof loadPlaybooks>>["entries"][number]["playbook"];
beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coalesce-pb-"));
  dirs.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.resolve(__dirname, "..", "examples/.paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "t.yaml"), "title: T\nsteps:\n  - id: a\n    role: { name: implementer }\n");
  playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "t")!.playbook;
});
const fresh = () => newRun({ id: "run_x", playbook: playbook!, workspaceId: "ws", workspaceDir: "/w", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: "2026-01-01T00:00:00.000Z" });

describe("RunStore writes", () => {
  it("writes nothing when a mutation changed nothing, and compact JSON otherwise", async () => {
    const dir = await tmp();
    const store = new RunStore(dir);
    await store.init();
    await store.create(fresh());
    const file = path.join(dir, "run_x.json");
    const before = await stat(file);
    const seq = store.get("run_x")!.seq;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.mutate("run_x", () => undefined);
    const same = await stat(file);
    expect(same.mtimeMs).toBe(before.mtimeMs);
    expect(store.get("run_x")!.seq).toBe(seq);
    await store.mutate("run_x", (run) => void (run.name = "named"));
    const text = await readFile(file, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text).name).toBe("named");
  });

  it("still loads a run file written pretty by an older version", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "run_x.json"), `${JSON.stringify(fresh(), null, 2)}\n`);
    const store = new RunStore(dir);
    await store.init();
    expect(store.get("run_x")?.id).toBe("run_x");
  });
});

describe("UsageLedger saves", () => {
  it("coalesces turns into few writes and flush leaves everything on disk", async () => {
    const dir = await tmp();
    const file = path.join(dir, "agent-usage.json");
    const ledger = new UsageLedger(file);
    const info = { title: "M", kind: "manager", role: null, model: "claude/opus", runId: "r1" };
    for (let n = 1; n <= 20; n++) await ledger.record("a", info, { inputTokens: n, cachedInputTokens: 0, outputTokens: 1, contextWindowUsedTokens: 1 });
    await expect(readFile(file, "utf8")).rejects.toThrow();
    await ledger.flush();
    const text = await readFile(file, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text).a.usage.inputTokens).toBe(20);
  });
});

describe("EventBus saves", () => {
  it("keeps every event, in order, across a restart without waiting for the debounce", async () => {
    const root = await tmp();
    const files = { events: path.join(root, "events.json"), subscriptions: path.join(root, "subs.json") };
    const make = () => {
      const bus = new EventBus(files, { debounceMs: 0 });
      bus.register({ type: "a.one", description: "", payload: z.object({ n: z.number() }), line: () => "-" });
      return bus;
    };
    const first = make();
    for (let n = 1; n <= 50; n++) await first.emit("a.one", { n }, { source: "test" });
    await first.close();
    const again = make();
    const { events } = await again.recent({ since: 0, limit: 100 });
    expect(events.map((event) => event.payload.n)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect((await again.emit("a.one", { n: 51 }, { source: "test" })).seq).toBe(51);
    await again.close();
  });
});

describe("OversightProducer lifecycle", () => {
  it("announces new history entries once, and does not re-walk a run whose seq did not move", async () => {
    const root = await tmp();
    const bus = new EventBus({ events: path.join(root, "e.json"), subscriptions: path.join(root, "s.json") }, { debounceMs: 0 });
    const producer = new OversightProducer(bus);
    const run = fresh();
    await producer.scan([run], Date.now());
    let reads = 0;
    const history = run.history;
    Object.defineProperty(run, "history", { get: () => (reads++, history) });
    await producer.scan([run], Date.now());
    expect(reads).toBe(0);
    await bus.close();
  });
});
