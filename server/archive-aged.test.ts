import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const HOURS = 3_600_000;
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });

type Opts = { work?: "clean" | "uncommitted" | "unpushed"; created?: boolean; sibling?: "active" | "ended"; status?: "completed" | "canceled" | "failed"; defaults?: string; checkout?: boolean };

/** A run that ended, in a real git workspace directory (with a bare remote), and a fake daemon that records archived workspaces. */
async function setup(opts: Opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ws-aged-"));
  temps.push(dir);
  const work = path.join(dir, "work");
  const remote = path.join(dir, "remote.git");
  await mkdir(work);
  git(dir, "init", "--bare", "-b", "main", remote);
  git(work, "init", "-b", "main");
  await writeFile(path.join(work, "a.txt"), "a");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "one");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "origin", "main");
  const root = path.join(work, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  if (opts.defaults) await writeFile(path.join(root, "defaults/main.yaml"), opts.defaults);
  await writeFile(path.join(root, "main.yaml"), `title: Main\nsteps:\n  - id: a\n    role: { name: implementer }\n`);
  git(work, "add", ".paseo");
  git(work, "commit", "-m", "playbooks");
  git(work, "push", "origin", "main");
  if (opts.work === "uncommitted") await writeFile(path.join(work, "b.txt"), "b");
  if (opts.work === "unpushed") {
    await writeFile(path.join(work, "b.txt"), "b");
    git(work, "add", "b.txt");
    git(work, "commit", "-m", "two");
  }
  const entry = (await loadPlaybooks(work)).entries.find((candidate) => candidate.id === "main")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const base = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: work, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, workspaceCreated: opts.created ?? true, now: new Date().toISOString() });
  await store.create(base);
  if (opts.sibling) await store.create({ ...structuredClone(base), id: "run_y", status: opts.sibling === "active" ? "running" : "completed" });
  const archived: string[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: "m", workspaceId: "ws", labels: { "playbooks/manager": "true" }, archivedAt: null, internal: false, status: "idle", pendingPermissions: [] } }] }),
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, status: "idle", archivedAt: null } }), archive: async () => ({ archivedAt: "x" }), send: async () => undefined }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: work, projectRootPath: opts.checkout ? work : path.join(dir, "root") }), archive: async () => void archived.push(id) }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  await runtime.cancelRun("run_x", "done", null);
  if (opts.status && opts.status !== "canceled") await store.mutate("run_x", (run) => void (run.status = opts.status!));
  const sweep = async (hoursLater: number) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(store.get("run_x")!.updatedAt) + hoursLater * HOURS);
    await (runtime as unknown as { archiveAgedWorkspaces(): Promise<void> }).archiveAgedWorkspaces();
  };
  return { store, runtime, archived, sweep };
}

const kept = (store: RunStore) => store.get("run_x")!.history.filter((e) => e.type === "workspace_kept").map((e) => e.detail);

describe("workspace.archive_after (default 6h)", () => {
  it("archives the workspace of a canceled run 6h after it ended, and not before", async () => {
    const { store, archived, sweep } = await setup();
    await sweep(5);
    expect(archived).toEqual([]);
    await sweep(6);
    expect(archived).toEqual(["ws"]);
    expect(store.get("run_x")!.workspaceArchive).toBe("done");
    expect(store.get("run_x")!.archivedAt).toBeNull();
  });

  it("archives a completed run's workspace too", async () => {
    const { archived, sweep } = await setup({ status: "completed" });
    await sweep(7);
    expect(archived).toEqual(["ws"]);
  });

  it("keeps the workspace of a failed run (explicit archive only)", async () => {
    const { archived, sweep } = await setup({ status: "failed" });
    await sweep(100);
    expect(archived).toEqual([]);
  });

  it("honours a custom delay and `never`", async () => {
    const short = await setup({ defaults: "workspace: { archive_after: 1h }\n" });
    await short.sweep(1);
    expect(short.archived).toEqual(["ws"]);
    const off = await setup({ defaults: "workspace: { archive_after: never }\n" });
    await off.sweep(1000);
    expect(off.archived).toEqual([]);
  });

  it("keeps a workspace with uncommitted changes, and says why", async () => {
    const { archived, sweep, store } = await setup({ work: "uncommitted" });
    await sweep(7);
    expect(archived).toEqual([]);
    expect(kept(store).join()).toContain("uncommitted changes");
  });

  it("keeps a workspace with unpushed commits, and says why", async () => {
    const { archived, sweep, store } = await setup({ work: "unpushed" });
    await sweep(7);
    expect(archived).toEqual([]);
    expect(kept(store).join()).toContain("not pushed");
  });

  it("keeps a workspace another run is still active in", async () => {
    const { archived, sweep } = await setup({ sibling: "active" });
    await sweep(7);
    expect(archived).toEqual([]);
  });

  it("archives past an ended sibling run", async () => {
    const { archived, sweep } = await setup({ sibling: "ended" });
    await sweep(7);
    expect(archived[0]).toBe("ws"); // the sibling's own sweep finds the workspace gone in the real daemon
  });

  it("never archives a workspace the run did not create, nor the project checkout", async () => {
    const notCreated = await setup({ created: false });
    await notCreated.sweep(7);
    expect(notCreated.archived).toEqual([]);
    const checkout = await setup({ created: false, checkout: true });
    await checkout.sweep(7);
    expect(checkout.archived).toEqual([]);
  });
});

describe("archiving the run archives its workspace by default", () => {
  it("archives a clean workspace", async () => {
    const { runtime, archived } = await setup();
    const result = await runtime.archiveRunByAgent("run_x", false);
    expect(archived).toEqual(["ws"]);
    expect(result.workspaceArchived).toEqual({ archived: true, reason: "archived" });
  });

  it("keeps a workspace with uncommitted changes or unpushed commits", async () => {
    for (const work of ["uncommitted", "unpushed"] as const) {
      const { runtime, archived } = await setup({ work });
      const result = await runtime.archiveRunByAgent("run_x", false);
      expect(archived).toEqual([]);
      expect(result.workspaceArchived?.archived).toBe(false);
    }
  });

  it("keeps it for an active sibling run, and with archive_with_run: false", async () => {
    const sibling = await setup({ sibling: "active" });
    await sibling.runtime.archiveRunByAgent("run_x", false);
    expect(sibling.archived).toEqual([]);
    const off = await setup({ defaults: "workspace: { archive_with_run: false }\n" });
    await off.runtime.archiveRunByAgent("run_x", false);
    expect(off.archived).toEqual([]);
  });
});
