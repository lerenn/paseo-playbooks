import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: { playbook?: string; defaults?: string; used?: number }) {
  const dir = await mkdtemp(path.join(tmpdir(), "compact-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  if (options.defaults) await writeFile(path.join(root, "defaults/main.yaml"), options.defaults);
  await writeFile(path.join(root, "release.yaml"), `${options.playbook ?? ""}steps:\n  - id: release\n    role: { name: implementer }\n    outputs: { pr: {} }\n`);
  const loaded = await loadPlaybooks(dir);
  const entry = loaded.entries.find((e) => e.id === "release")!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const sent: Array<{ agentId: string; text: string }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", archivedAt: null, lastUsage: { contextWindowUsedTokens: options.used ?? 0 } } }),
    send: async (text: string) => {
      sent.push({ agentId, text });
    },
    reload: async () => null,
  });
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach({ agents: { ref } } as never);
  return { entry, store, runtime, sent, dir };
}

/** A run whose manager "m" was woken once and then ended its turn. */
async function woken(options: Parameters<typeof setup>[0]) {
  const ctx = await setup(options);
  const playbook = ctx.entry.playbook!;
  const run = newRun({ id: "run_x", playbook, workspaceId: "ws", workspaceDir: ctx.dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
  await ctx.store.create(run);
  await ctx.store.mutate("run_x", (r) => {
    r.inbox.push("[playbooks] run_x · a step ended");
  });
  await ctx.runtime.deliver("run_x");
  ctx.sent.length = 0;
  await ctx.runtime.onManagerTurnEnded("m");
  return ctx;
}

describe("manager.compact", () => {
  it("defaults to above_tokens 150000, from the defaults file or the playbook", async () => {
    expect((await setup({})).entry.playbook!.managerCompact).toEqual({ above_tokens: 150_000 });
    expect((await setup({ defaults: "manager: { compact: never }\n" })).entry.playbook!.managerCompact).toBe("never");
    const both = await setup({ defaults: "manager: { compact: never }\n", playbook: "manager: { compact: on_step }\n" });
    expect(both.entry.playbook!.managerCompact).toBe("on_step");
  });

  it("is refused when malformed", async () => {
    const bad = await setup({ playbook: "manager: { compact: sometimes }\n" });
    expect(bad.entry.errors.join("\n")).toMatch(/compact/);
  });

  it("on_step sends /compact, as a plain message, once the manager handled a wake-up", async () => {
    const { sent } = await woken({ playbook: "manager: { compact: on_step }\n" });
    expect(sent).toEqual([{ agentId: "m", text: "/compact" }]);
  });

  it("never sends nothing", async () => {
    expect((await woken({ playbook: "manager: { compact: never }\n" })).sent).toEqual([]);
  });

  it("on_gate_decided ignores a plain wake-up", async () => {
    expect((await woken({ playbook: "manager: { compact: on_gate_decided }\n" })).sent).toEqual([]);
  });

  it("above_tokens compacts only a context over the limit, and ignores a zero reading", async () => {
    const playbook = "manager: { compact: { above_tokens: 1000 } }\n";
    expect((await woken({ playbook, used: 5000 })).sent).toEqual([{ agentId: "m", text: "/compact" }]);
    expect((await woken({ playbook, used: 900 })).sent).toEqual([]);
    expect((await woken({ playbook, used: 0 })).sent).toEqual([]);
  });

  it("waits while a wake-up is queued, and does not repeat without a new wake-up", async () => {
    const ctx = await woken({ playbook: "manager: { compact: on_step }\n" });
    expect(ctx.sent).toHaveLength(1);
    await ctx.runtime.onManagerTurnEnded("m"); // the compaction's own turn ended
    expect(ctx.sent).toHaveLength(1);
  });
});
