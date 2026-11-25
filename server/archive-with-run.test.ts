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

type FakeAgent = { id: string; labels?: Record<string, string>; status?: string; pendingPermissions?: unknown[] };
const MANAGER: FakeAgent = { id: "m", labels: { "playbooks/manager": "true" } };

async function setup(opts: { on?: boolean; agents?: FakeAgent[]; goneWorkspace?: boolean; other?: "active" | "archived"; status?: "completed" | "failed" | "canceled" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ws-with-run-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  if (opts.on === false) await writeFile(path.join(root, "defaults/main.yaml"), "workspace: { archive_with_run: false }\n");
  await writeFile(path.join(root, "main.yaml"), `title: Main\nsteps:\n  - id: a\n    role: { name: implementer }\n`);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "main")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const base = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, workspaceCreated: true, now: new Date().toISOString() });
  await store.create(base);
  if (opts.other) await store.create({ ...structuredClone(base), id: "run_y", status: opts.other === "active" ? "running" : "completed", archivedAt: opts.other === "archived" ? new Date().toISOString() : null });
  const archived: string[] = [];
  const agents = opts.agents ?? [MANAGER];
  const paseo = {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent: { workspaceId: "ws", archivedAt: null, internal: false, status: "idle", pendingPermissions: [], ...agent } })) }),
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, status: "idle", archivedAt: null } }), archive: async () => ({ archivedAt: "x" }), send: async () => undefined }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => (opts.goneWorkspace ? null : { id, projectId: "p", workspaceDirectory: dir }), archive: async () => void archived.push(id) }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  await runtime.cancelRun("run_x", "done", null);
  const status = opts.status;
  if (status && status !== "canceled") await store.mutate("run_x", (run) => void (run.status = status));
  return { store, runtime, archived };
}

describe("workspace.archive_with_run", () => {
  it("archives the workspace with the run and says so", async () => {
    const { runtime, store, archived } = await setup();
    const result = await runtime.archiveRunByAgent("run_x", false);
    expect(archived).toEqual(["ws"]);
    expect(result.workspaceArchived).toEqual({ archived: true, reason: "archived" });
    expect(store.get("run_x")!.history.some((e) => e.type === "workspace_archived")).toBe(true);
  });

  it("works for a failed run and through archiveRun (panel)", async () => {
    const { runtime, archived } = await setup({ status: "failed" });
    await runtime.archiveRun("run_x");
    expect(archived).toEqual(["ws"]);
  });

  it("is off by default", async () => {
    const { runtime, archived } = await setup({ on: false });
    const result = await runtime.archiveRunByAgent("run_x", false);
    expect(archived).toEqual([]);
    expect(result.workspaceArchived).toEqual({ archived: false, reason: "workspace.archive_with_run is off" });
  });

  const skipped = async (ctx: Awaited<ReturnType<typeof setup>>, reason: RegExp) => {
    const result = await ctx.runtime.archiveRunByAgent("run_x", false);
    expect(ctx.archived).toEqual([]);
    expect(result.workspaceArchived!.archived).toBe(false);
    expect(result.workspaceArchived!.reason).toMatch(reason);
    expect(ctx.store.get("run_x")!.archivedAt).not.toBeNull();
    expect(ctx.store.get("run_x")!.history.find((e) => e.type === "workspace_kept")!.detail).toMatch(reason);
  };

  it("is skipped while another run that is not archived uses the workspace", async () => {
    await skipped(await setup({ other: "active" }), /run_y/);
    await skipped(await setup({ other: "archived" }).then(async (ctx) => (await ctx.store.mutate("run_y", (r) => void (r.archivedAt = null)), ctx)), /run_y/);
  });

  it("is archived when the other run on the workspace is archived too", async () => {
    const { runtime, archived } = await setup({ other: "archived" });
    await runtime.archiveRun("run_x");
    expect(archived).toEqual(["ws"]);
  });

  it("is skipped while an agent runs or waits on a permission", async () => {
    await skipped(await setup({ agents: [MANAGER, { id: "s", labels: { "playbooks/run": "run_x", "playbooks/step": "a" }, status: "running" }] }), /agent s/);
    await skipped(await setup({ agents: [MANAGER, { id: "s", labels: { "playbooks/run": "run_x" }, pendingPermissions: [{ id: "p" }] }] }), /agent s/);
  });

  it("is skipped when the workspace is gone or already archived", async () => {
    await skipped(await setup({ goneWorkspace: true }), /no longer exists or is already archived/);
  });

  it("is skipped when it holds an agent that is not part of a run", async () => {
    await skipped(await setup({ agents: [MANAGER, { id: "human" }] }), /human/);
  });

  it("is skipped for a run that has not ended, which cannot be archived at all", async () => {
    const { runtime, store, archived } = await setup();
    await store.mutate("run_x", (run) => void (run.status = "running"));
    await expect(runtime.archiveRunByAgent("run_x", false)).rejects.toThrow(/cancel it before archiving/);
    expect(archived).toEqual([]);
  });

  it("is tried once: archiving an archived run does not archive again", async () => {
    const { runtime, archived } = await setup();
    await runtime.archiveRunByAgent("run_x", false);
    const again = await runtime.archiveRunByAgent("run_x", false);
    expect(again.already).toBe(true);
    expect(again.workspaceArchived).toBeNull();
    expect(archived).toEqual(["ws"]);
  });

  it("leaves restart_run working through workspaceId when the workspace is gone", async () => {
    const { runtime } = await setup({ goneWorkspace: true });
    await runtime.archiveRun("run_x");
    await expect(runtime.restartRun("run_x", "a", null, null)).rejects.toThrow(/no longer exists[\s\S]*Pass workspaceId/);
  });
});

describe("cancelRun when the record disappears during the cancel", () => {
  it("returns the canceled run instead of throwing on a missing record", async () => {
    const { runtime, store } = await setup({ status: "completed" });
    await store.mutate("run_x", (run) => void (run.status = "running"));
    const apply = (runtime as unknown as { applyEffects: (id: string, effects: unknown) => Promise<void> }).applyEffects.bind(runtime);
    (runtime as unknown as { applyEffects: unknown }).applyEffects = async (id: string, effects: unknown) => {
      await apply(id, effects);
      await store.delete(id);
    };
    const run = await runtime.cancelRun("run_x", "gone", "by agent a");
    expect(run.id).toBe("run_x");
    expect(run.status).toBe("canceled");
    expect(store.get("run_x")).toBeUndefined();
  });
});
