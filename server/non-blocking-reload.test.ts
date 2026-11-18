/**
 * After a plugin update the daemon's hooks and the panel's RPCs must keep being answered while the sessions
 * of dozens of agents are reloaded (each reload slow on the daemon's side).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime, STEP_LABEL } from "./runtime";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(agentCount: number, reloadMs: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "non-blocking-"));
  temps.push(dir);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const ids = Array.from({ length: agentCount }, (_, i) => `a${i}`);
  let active = 0;
  let maxActive = 0;
  let reloads = 0;
  const entries = ids.map((id) => ({ agent: { id, status: "idle", archivedAt: null, labels: { [STEP_LABEL]: "s" }, cwd: tmpdir(), pendingPermissions: [] } }));
  const paseo = {
    agents: {
      list: async () => ({ entries, pageInfo: { nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: entries.find((e) => e.agent.id === id)!.agent }),
        reload: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(reloadMs);
          active--;
          reloads++;
        },
      }),
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { nextCursor: null } }) },
    permissions: { list: async () => ({ entries: [] }) },
  };
  const runtime = new Runtime(store, { dataDir: dir, reloadConcurrency: 4, reloadPauseMs: 1 });
  runtimes.push(runtime);
  return { runtime, paseo: paseo as never, stats: () => ({ maxActive, reloads }) };
}

describe("the post-update reload does not block hooks and RPCs", () => {
  it("reloads with bounded concurrency", async () => {
    const { runtime, paseo, stats } = await setup(24, 20);
    await runtime.attach(paseo);
    expect(stats().reloads).toBe(24);
    expect(stats().maxActive).toBeGreaterThan(1);
    expect(stats().maxActive).toBeLessThanOrEqual(4);
  });

  it("answers entry points within a small budget while the reload is running", async () => {
    // 60 agents x 100 ms / 4 at a time: the reload lasts ~1.5 s.
    const { runtime, paseo, stats } = await setup(60, 100);
    const started = Date.now();
    const latencies: number[] = [];
    for (let i = 0; i < 10; i++) {
      const at = Date.now();
      await runtime.enter(paseo);
      latencies.push(Date.now() - at);
      await sleep(50);
    }
    // Hooks and RPCs were served while the reload was still in progress ...
    expect(stats().reloads).toBeLessThan(60);
    expect(Date.now() - started).toBeLessThan(1_400);
    // ... each within a small budget, instead of after the whole reload.
    expect(Math.max(...latencies)).toBeLessThan(150);
    await runtime.attach(paseo);
    expect(stats().reloads).toBe(60);
  });
});
