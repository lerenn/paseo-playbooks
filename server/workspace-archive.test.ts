import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
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

type FakeAgent = { id: string; workspaceId: string; labels?: Record<string, string>; status?: string };

async function setup(opts: { workspace?: string; created?: boolean; agents?: FakeAgent[]; gate?: boolean; defaults?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ws-archive-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  if (opts.defaults) {
    await mkdir(path.join(root, "defaults"), { recursive: true });
    await writeFile(path.join(root, "defaults/main.yaml"), opts.defaults);
  }
  await writeFile(path.join(root, "main.yaml"), `title: Main\n${opts.workspace ?? ""}steps:\n  - id: a\n    role: { name: implementer }\n`);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "main")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, workspaceCreated: opts.created ?? true, now: new Date().toISOString() });
  await store.create(run);
  const archived: string[] = [];
  const agents: FakeAgent[] = opts.agents ?? [{ id: "m", workspaceId: "ws", labels: { "playbooks/manager": "true" } }];
  const paseo = {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent: { archivedAt: null, internal: false, status: "idle", ...agent } })) }),
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, status: "idle", archivedAt: null } }), archive: async () => ({ archivedAt: "x" }), send: async () => undefined }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p" }), archive: async () => void archived.push(id) }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  if (opts.gate) {
    // A finished run of the same workspace still has a question open for a human.
    await store.create({ ...structuredClone(run), id: "run_y", workspaceCreated: false, status: "completed", gates: [{ id: "g", stepId: "a", status: "pending" } as never] });
  }
  return { store, runtime, archived };
}

async function end(ctx: Awaited<ReturnType<typeof setup>>, how: "cancel" | "fail" = "cancel"): Promise<Run> {
  if (how === "cancel") await ctx.runtime.cancelRun("run_x", "done", null);
  else await (ctx.runtime as unknown as { failRun(id: string, reason: string): Promise<void> }).failRun("run_x", "boom");
  await ctx.runtime.onTurnEnded("m", "completed");
  return ctx.store.get("run_x")!;
}

const ON_END = "workspace: { archive: on_end }\n";

describe("workspace.archive", () => {
  it("archives a plugin-created workspace when the run ends", async () => {
    const ctx = await setup({ workspace: ON_END });
    const run = await end(ctx);
    expect(ctx.archived).toEqual(["ws"]);
    expect(run.workspaceArchive).toBe("done");
    expect(run.history.some((e) => e.type === "workspace_archived")).toBe(true);
  });

  it("defaults to never", async () => {
    const ctx = await setup();
    expect(ctx.store.get("run_x")!.playbook.workspace).toEqual({ archive: "never", keepFailed: true });
    await end(ctx);
    expect(ctx.archived).toEqual([]);
  });

  it("takes the repository default, which a playbook overrides", async () => {
    const a = await setup({ defaults: ON_END });
    await end(a);
    expect(a.archived).toEqual(["ws"]);
    const b = await setup({ defaults: ON_END, workspace: "workspace: { archive: never }\n" });
    await end(b);
    expect(b.archived).toEqual([]);
  });

  it("is skipped, with a reason, when another agent lives in the workspace", async () => {
    const ctx = await setup({ workspace: ON_END, agents: [{ id: "m", workspaceId: "ws", labels: { "playbooks/manager": "true" } }, { id: "human", workspaceId: "ws" }] });
    const run = await end(ctx);
    expect(ctx.archived).toEqual([]);
    expect(run.status).toBe("canceled");
    expect(run.history.find((e) => e.type === "workspace_kept")!.detail).toMatch(/human/);
  });

  it("is skipped with an open gate", async () => {
    const ctx = await setup({ workspace: ON_END, gate: true });
    const run = await end(ctx);
    expect(ctx.archived).toEqual([]);
    expect(run.history.find((e) => e.type === "workspace_kept")!.detail).toMatch(/open gate/);
  });

  it("keeps the workspace of a failed run while keep_failed is true", async () => {
    const ctx = await setup({ workspace: ON_END });
    const run = await end(ctx, "fail");
    expect(ctx.archived).toEqual([]);
    expect(run.history.find((e) => e.type === "workspace_kept")!.detail).toMatch(/keep_failed/);
    const other = await setup({ workspace: "workspace: { archive: on_end, keep_failed: false }\n" });
    await end(other, "fail");
    expect(other.archived).toEqual(["ws"]);
  });

  it("never touches a workspace the plugin did not create", async () => {
    const ctx = await setup({ workspace: ON_END, created: false });
    const run = await end(ctx);
    expect(ctx.archived).toEqual([]);
    expect(run.workspaceArchive).toBeNull();
  });

  it("waits while an agent is still running", async () => {
    const ctx = await setup({ workspace: ON_END, agents: [{ id: "m", workspaceId: "ws", status: "running", labels: { "playbooks/manager": "true" } }] });
    const run = await end(ctx);
    expect(ctx.archived).toEqual([]);
    expect(run.workspaceArchive).toBeNull();
  });
});
