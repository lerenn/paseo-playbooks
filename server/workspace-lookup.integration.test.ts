/**
 * The real workspace lookup (server/workspace-lookup.ts) under the real Runtime, with only the daemon's paginated
 * workspace list faked. The other server tests replace the lookup (test/legacy-workspace-lookup.ts).
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelRun, newRun, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { BACKGROUND_UNSUPPORTED } from "./workspace-lookup";
import type { Playbook } from "../shared/types";

vi.unmock("./workspace-lookup");

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Ws = { id: string; projectId: string; background?: boolean };
const full = (w: Ws) => ({ id: w.id, projectId: w.projectId, projectDisplayName: w.projectId, projectRootPath: tmpdir(), workspaceDirectory: tmpdir() });

/** A daemon whose only workspace source is a paginated `list` (page size 1, to cross pages), with failure injection. */
function fakeDaemon(initial: Ws[], options: { supportsBackground?: boolean } = {}) {
  const inventory = [...initial];
  const supportsBackground = options.supportsBackground ?? true;
  const calls: Array<{ filtered: boolean }> = [];
  const failures: Error[] = [];
  const created: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const list = vi.fn(async (request: { filter?: { includeBackground?: boolean }; page: { cursor?: string } }) => {
    const filtered = Boolean(request.filter?.includeBackground);
    if (!request.page.cursor) calls.push({ filtered });
    if (filtered && !supportsBackground) throw new Error(BACKGROUND_UNSUPPORTED);
    const failure = failures.shift();
    if (failure) throw failure;
    const visible = inventory.filter((w) => filtered || !w.background);
    const start = request.page.cursor ? Number(request.page.cursor) : 0;
    return { entries: visible.slice(start, start + 1).map(full), pageInfo: { nextCursor: start + 1 < visible.length ? String(start + 1) : null } };
  });
  const agents = new Map<string, { archivedAt: string | null }>();
  const agentRef = (id: string) => ({
    refresh: async () => (agents.has(id) ? { agent: { id, status: "idle", provider: "claude", model: null, archivedAt: agents.get(id)!.archivedAt } } : null),
    send: async () => undefined,
    reload: async () => null,
    archive: async () => void (agents.get(id)!.archivedAt = new Date().toISOString()),
    timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message" }, timestamp: new Date().toISOString() }] }) },
  });
  const workspaceRef = (id: string) => ({
    id,
    archive: async () => {
      archived.push(id);
      const at = inventory.findIndex((w) => w.id === id);
      if (at >= 0) inventory.splice(at, 1);
    },
    agents: {
      create: async () => {
        const agentId = `agent-${agents.size + 1}`;
        agents.set(agentId, { archivedAt: null });
        return { id: agentId, ...agentRef(agentId) };
      },
    },
  });
  const paseo = {
    agents: { ref: agentRef, list: async () => ({ entries: [] }) },
    workspaces: {
      list,
      ref: workspaceRef,
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        const id = `new-${created.length}`;
        inventory.push({ id, projectId: (input.projectId as string | undefined) ?? "a", background: input.background === true });
        return workspaceRef(id);
      },
    },
  };
  return { paseo, inventory, calls, failures, created, archived, list, agents };
}

async function boot(daemon: ReturnType<typeof fakeDaemon>) {
  const dir = await mkdtemp(path.join(tmpdir(), "wl-int-"));
  temps.push(dir);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(daemon.paseo as never);
  return { runtime, store, dir };
}

const timeout = () => new Error("Timed out waiting for fetch_workspaces_response");
const call = (runtime: Runtime, workspaceId: string) =>
  runtime.startPlaybookInWorkspace({ id: "sk", workspaceId: "hidden-a" }, { playbook: "x", inputs: {}, workspaceId, newWorkspace: true });

describe("project scoping through the real lookup", () => {
  const inventory: Ws[] = [
    { id: "hidden-a", projectId: "a", background: true },
    { id: "visible-a", projectId: "a" },
    { id: "visible-b", projectId: "b" },
  ];

  it("a Sidekick of project A cannot start in a workspace of project B", async () => {
    const { runtime } = await boot(fakeDaemon(inventory));
    vi.spyOn(runtime, "isSidekick").mockResolvedValue(true);
    const start = vi.spyOn(runtime, "startFromPanel").mockResolvedValue({ status: "started" } as never);
    await expect(call(runtime, "visible-b")).rejects.toThrow(/belongs to another project/);
    expect(start).not.toHaveBeenCalled();
    await expect(call(runtime, "visible-a")).resolves.toMatchObject({ status: "started" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a transient timeout on the filtered list never yields a partial list: the start is refused, not guarded away, and the retry still rejects cross-project", async () => {
    const daemon = fakeDaemon(inventory);
    const { runtime } = await boot(daemon);
    vi.spyOn(runtime, "isSidekick").mockResolvedValue(true);
    const start = vi.spyOn(runtime, "startFromPanel").mockResolvedValue({ status: "started" } as never);
    daemon.failures.push(timeout());
    await expect(call(runtime, "visible-b")).rejects.toThrow(/Timed out/);
    expect(daemon.calls.every((c) => c.filtered)).toBe(true);
    await expect(call(runtime, "visible-b")).rejects.toThrow(/belongs to another project/);
    expect(start).not.toHaveBeenCalled();
  });

  it("an unknown caller project fails closed", async () => {
    const { runtime } = await boot(fakeDaemon(inventory));
    vi.spyOn(runtime, "isSidekick").mockResolvedValue(true);
    const start = vi.spyOn(runtime, "startFromPanel").mockResolvedValue({ status: "started" } as never);
    await expect(runtime.startPlaybookInWorkspace({ id: "sk", workspaceId: "vanished" }, { playbook: "x", inputs: {}, workspaceId: "visible-b", newWorkspace: true })).rejects.toThrow(/caller's project/);
    await expect(runtime.startPlaybookInWorkspace({ id: "sk", workspaceId: null }, { playbook: "x", inputs: {}, workspaceId: "visible-b", newWorkspace: true })).rejects.toThrow(/caller's project/);
    expect(start).not.toHaveBeenCalled();
  });

  it("on a host without background workspaces it falls back to the plain list", async () => {
    const daemon = fakeDaemon(inventory.filter((w) => !w.background), { supportsBackground: false });
    const { runtime } = await boot(daemon);
    expect((await runtime.lookupWorkspace("visible-b"))?.projectId).toBe("b");
    expect(daemon.calls.map((c) => c.filtered)).toEqual([true, false]);
  });
});

describe("cache invalidation through the real lookup", () => {
  it("a workspace the plugin creates is found at once, though the cached list is fresh", async () => {
    const daemon = fakeDaemon([{ id: "a1", projectId: "a" }]);
    const { runtime } = await boot(daemon);
    await runtime.lookupWorkspace("a1");
    const created = await (runtime as unknown as { createWorkspace(o: unknown): Promise<{ id: string }> }).createWorkspace({ title: "t" });
    expect((await runtime.lookupWorkspace(created.id))?.id).toBe(created.id);
  });

  it("a workspace the plugin archives is gone at once", async () => {
    const daemon = fakeDaemon([{ id: "a1", projectId: "a" }, { id: "a2", projectId: "a" }]);
    const { runtime } = await boot(daemon);
    expect(await runtime.lookupWorkspace("a2")).not.toBeNull();
    await (runtime as unknown as { archiveWorkspace(id: string): Promise<unknown> }).archiveWorkspace("a2");
    expect(await runtime.lookupWorkspace("a2")).toBeNull();
  });

  it("repeated lookups of listed workspaces cost one pass over the pages (the flood fix holds)", async () => {
    const daemon = fakeDaemon([{ id: "a1", projectId: "a" }, { id: "a2", projectId: "a" }, { id: "b1", projectId: "b" }]);
    const { runtime } = await boot(daemon);
    await Promise.all(Array.from({ length: 30 }, (_, i) => runtime.lookupWorkspace(["a1", "a2", "b1"][i % 3]!)));
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.list).toHaveBeenCalledTimes(3);
  });
});

describe("restart decisions through the real lookup", () => {
  async function playbook(): Promise<Playbook> {
    const dir = await mkdtemp(path.join(tmpdir(), "wl-pb-"));
    temps.push(dir);
    const root = path.join(dir, ".paseo/playbooks");
    await mkdir(root, { recursive: true });
    await cp(path.resolve(__dirname, "..", "examples/.paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
    await writeFile(path.join(root, "main.yaml"), "title: Main\nsteps:\n  - id: one\n    role: { name: investigator }\n    outputs: { plan: {} }\n");
    return (await loadPlaybooks(dir)).entries.find((e) => e.id === "main")!.playbook!;
  }
  async function withRun(daemon: ReturnType<typeof fakeDaemon>) {
    const booted = await boot(daemon);
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, tick++)).toISOString();
    const run = newRun({ id: "run_r", playbook: await playbook(), workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
    startAttempt(run, "one", { agentId: "x", brief: "", now: now(), readonlySnapshot: null });
    cancelRun(run, "stop", now());
    await booted.store.create(run);
    daemon.agents.set("m", { archivedAt: null });
    return booted;
  }

  it("archiving a workspace together with its run drops the cached list", async () => {
    const daemon = fakeDaemon([{ id: "ws", projectId: "p" }]);
    const { runtime, store } = await withRun(daemon);
    expect(await runtime.lookupWorkspace("ws")).not.toBeNull();
    const outcome = await (runtime as unknown as { archiveWorkspaceWithRun(run: unknown): Promise<{ archived: boolean }> }).archiveWorkspaceWithRun(store.get("run_r")!);
    expect(outcome.archived).toBe(true);
    expect(daemon.archived).toEqual(["ws"]);
    expect(await runtime.lookupWorkspace("ws")).toBeNull();
  });

  it("a transient daemon failure is reported as such, not as \"its workspace no longer exists\"", async () => {
    const daemon = fakeDaemon([{ id: "ws", projectId: "p" }]);
    const { runtime } = await withRun(daemon);
    daemon.failures.push(timeout());
    await expect(runtime.restartRun("run_r", "one", null, "laptop")).rejects.toThrow(/Timed out/);
  });

  it("a workspace restored since the last fetch (no created event) is found, not declared gone", async () => {
    const daemon = fakeDaemon([{ id: "other", projectId: "p" }]);
    const { runtime } = await withRun(daemon);
    await runtime.lookupWorkspace("other");
    daemon.inventory.push({ id: "ws", projectId: "p" });
    const result = await runtime.restartRun("run_r", "one", null, "laptop");
    expect(result.run.workspaceId).toBe("ws");
  });

  it("a workspace the daemon really lacks is still reported gone", async () => {
    const { runtime } = await withRun(fakeDaemon([{ id: "other", projectId: "p" }]));
    await expect(runtime.restartRun("run_r", "one", null, "laptop")).rejects.toThrow(/no longer exists/);
  });

  it("the auto-archive check marks a workspace restored since the last fetch as alive, not as gone", async () => {
    const daemon = fakeDaemon([{ id: "other", projectId: "p" }]);
    const { runtime } = await withRun(daemon);
    await runtime.lookupWorkspace("other");
    daemon.inventory.push({ id: "ws", projectId: "p" });
    const verdict = await (runtime as unknown as { workspaceArchiveVerdict(id: string): Promise<unknown> }).workspaceArchiveVerdict("run_r");
    expect(verdict).not.toEqual({ skip: "the workspace no longer exists" });
  });
});

describe("Sidekick workspace reuse through the real lookup", () => {
  async function shop() {
    const daemon = fakeDaemon([{ id: "ws-shop", projectId: "shop" }]);
    const { runtime, dir } = await boot(daemon);
    const root = path.join(dir, "shop");
    await mkdir(path.join(root, ".paseo/plugins/playbooks/sidekick"), { recursive: true });
    await writeFile(path.join(root, ".paseo/plugins/playbooks/sidekick/instructions.md"), "Rules.\n");
    daemon.inventory[0]!.projectId = "shop";
    // The project root comes from the listed workspace.
    const original = daemon.list.getMockImplementation()!;
    daemon.list.mockImplementation(async (request) => {
      const page = await original(request);
      return { ...page, entries: page.entries.map((e) => ({ ...e, projectRootPath: root, workspaceDirectory: root })) };
    });
    return { daemon, runtime };
  }

  it("reuses the existing hidden workspace and, when the daemon cannot be asked, creates no replacement", async () => {
    const { daemon, runtime } = await shop();
    const first = await runtime.openSidekick("ws-shop");
    expect(first).toMatchObject({ created: true });
    expect(daemon.created).toHaveLength(1);
    daemon.agents.get(first.agentId)!.archivedAt = new Date().toISOString();
    // A transient failure: refused, and no second hidden workspace.
    (runtime as unknown as { workspaces: { invalidate(): void } }).workspaces.invalidate();
    daemon.failures.push(timeout());
    await expect(runtime.openSidekick("ws-shop")).rejects.toThrow();
    expect(daemon.created).toHaveLength(1);
    // Healthy again: the hidden workspace (listed only with the background filter) is reused.
    const again = await runtime.openSidekick("ws-shop");
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(daemon.created).toHaveLength(1);
  });
});
