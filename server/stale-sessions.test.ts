import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reloadStaleSessionsSetting } from "./loader";
import { StaleSessions } from "./stale-sessions";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "stale-"));
  temps.push(dir);
  return dir;
}

type Snapshot = { status?: string; archivedAt?: string | null; pendingPermissions?: unknown[]; activeTurn?: unknown; cwd?: string };
function fakePaseo(agents: Record<string, Snapshot>, reloaded: string[]) {
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => (agents[id] ? { agent: { archivedAt: null, pendingPermissions: [], cwd: tmpdir(), ...agents[id] } } : null),
        reload: async () => {
          reloaded.push(id);
          return null;
        },
      }),
    },
  } as never;
}

/** The plugin loaded twice over the same data: the second load is "after a reload". */
async function twoGenerations() {
  const file = path.join(await tmp(), "sessions.json");
  const logs: string[] = [];
  const before = new StaleSessions(file, (m) => logs.push(m));
  const after = new StaleSessions(file, (m) => logs.push(m));
  return { before, after, logs };
}

describe("reloading stale sessions", () => {
  it("reloads an idle agent whose session was opened by an older generation, once", async () => {
    const { before, after, logs } = await twoGenerations();
    await before.noteOpened("a");
    await before.flush();
    const reloaded: string[] = [];
    const paseo = fakePaseo({ a: { status: "idle" } }, reloaded);
    expect(await after.reloadIfStale(paseo, "a")).toBe(true);
    expect(await after.reloadIfStale(paseo, "a")).toBe(false);
    expect(reloaded).toEqual(["a"]);
    expect(logs.join("\n")).toMatch(/reloading the session of agent a/);
  });

  it("leaves current, unrecorded and archived agents alone", async () => {
    const { before, after } = await twoGenerations();
    await before.noteOpened("old");
    await before.noteOpened("gone");
    await before.flush();
    await after.noteOpened("fresh");
    const reloaded: string[] = [];
    const paseo = fakePaseo({ old: { status: "idle" }, fresh: { status: "idle" }, never: { status: "idle" }, gone: { status: "idle", archivedAt: "x" } }, reloaded);
    for (const id of ["fresh", "never", "gone"]) expect(await after.reloadIfStale(paseo, id)).toBe(false);
    expect(reloaded).toEqual([]);
    expect(await after.reloadIfStale(paseo, "never", { known: true })).toBe(true);
    expect(reloaded).toEqual(["never"]);
  });

  it("never reloads a running agent, one with a pending permission, or one with an active turn", async () => {
    const { before, after } = await twoGenerations();
    for (const id of ["running", "asking", "turn"]) await before.noteOpened(id);
    await before.flush();
    const reloaded: string[] = [];
    const agents: Record<string, Snapshot> = { running: { status: "running" }, asking: { status: "idle", pendingPermissions: [{}] }, turn: { status: "idle", activeTurn: {} } };
    const paseo = fakePaseo(agents, reloaded);
    for (const id of Object.keys(agents)) expect(await after.reloadIfStale(paseo, id)).toBe(false);
    expect(reloaded).toEqual([]);
    // Its turn ends: now it is reloaded.
    agents.running = { status: "idle" };
    expect(await after.reloadIfStale(paseo, "running")).toBe(true);
  });

  it("retries a failed reload with a backoff, then gives up", async () => {
    const before = new StaleSessions(path.join(await tmp(), "s.json"), () => undefined);
    await before.noteOpened("a");
    await before.flush();
    const logs: string[] = [];
    const after = new StaleSessions(path.join(temps[0]!, "s.json"), (m) => logs.push(m), [5, 5]);
    let calls = 0;
    let failing = true;
    const paseo = {
      agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", archivedAt: null, pendingPermissions: [], cwd: tmpdir() } }), reload: async () => { calls++; if (failing) throw new Error("boom"); } }) },
    } as never;
    expect(await after.tryReload(paseo, "a")).toEqual({ kind: "failed", reason: "boom" });
    // Within the wait: not tried again by a caller.
    expect((await after.tryReload(paseo, "a")).kind).toBe("busy");
    expect(calls).toBe(1);
    // The scheduled retries run by themselves, then stop.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(3);
    expect(logs.join("\n")).toMatch(/could not reload.*boom.*retrying/);
    expect(logs.join("\n")).toMatch(/giving up after 3 attempts/);
    after.stop();
  });

  it("a retry that works reloads the agent once", async () => {
    const file = path.join(await tmp(), "s.json");
    const before = new StaleSessions(file, () => undefined);
    await before.noteOpened("a");
    await before.flush();
    const after = new StaleSessions(file, () => undefined, [5]);
    let calls = 0;
    const paseo = {
      agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", archivedAt: null, pendingPermissions: [], cwd: tmpdir() } }), reload: async () => { if (++calls === 1) throw new Error("starting"); } }) },
    } as never;
    expect((await after.tryReload(paseo, "a")).kind).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(2);
    expect(await after.reloadIfStale(paseo, "a")).toBe(false);
    expect(calls).toBe(2);
    after.stop();
  });

  it("skips an agent whose working directory is gone, quietly and for good", async () => {
    const { before, after, logs } = await twoGenerations();
    await before.noteOpened("a");
    await before.flush();
    const reloaded: string[] = [];
    const paseo = fakePaseo({ a: { status: "idle", cwd: path.join(await tmp(), "removed-worktree") } }, reloaded);
    expect(await after.tryReload(paseo, "a")).toEqual({ kind: "gone" });
    expect(await after.tryReload(paseo, "a")).toEqual({ kind: "current" });
    expect(reloaded).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("is switched off by reload_stale_sessions: false in the workspace's defaults", async () => {
    const { before, after } = await twoGenerations();
    await before.noteOpened("a");
    await before.flush();
    const dir = await tmp();
    await mkdir(path.join(dir, ".paseo/plugins/playbooks/defaults"), { recursive: true });
    await writeFile(path.join(dir, ".paseo/plugins/playbooks/defaults/main.yaml"), "reload_stale_sessions: false\n");
    expect(await reloadStaleSessionsSetting(dir)).toBe(false);
    expect(await reloadStaleSessionsSetting(await tmp())).toBe(true);
    const reloaded: string[] = [];
    expect(await after.reloadIfStale(fakePaseo({ a: { status: "idle", cwd: dir } }, reloaded), "a")).toBe(false);
    expect(reloaded).toEqual([]);
  });
});
