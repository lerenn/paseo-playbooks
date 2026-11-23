import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { runEndedAt, workspaceKeptUntil } from "../shared/types";
import { runListing } from "./tools";

const workspaceKeptUntilOf = (store: RunStore) => workspaceKeptUntil(store.get("run_x")!);

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

type Opts = { work?: "clean" | "uncommitted" | "unpushed"; created?: boolean; status?: "completed" | "canceled" | "failed"; defaults?: string; label?: boolean; managerStatus?: string; openGate?: boolean; openJob?: boolean };

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
  const archived: string[] = [];
  const agentsArchived: string[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: "m", workspaceId: "ws", labels: { "playbooks/manager": "true" }, archivedAt: null, internal: false, status: "idle", pendingPermissions: [] } }] }),
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, status: opts.managerStatus ?? "idle", archivedAt: null, labels: opts.label === false ? {} : { "playbooks/manager": "true" } } }), archive: async () => void agentsArchived.push(id), send: async () => undefined }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: work, projectRootPath: path.join(dir, "root") }), archive: async () => void archived.push(id) }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  await runtime.cancelRun("run_x", "done", null);
  if (opts.status && opts.status !== "canceled") await store.mutate("run_x", (run) => void (run.status = opts.status!));
  if (opts.openGate) await store.mutate("run_x", (run) => void run.gates.push({ id: "g", kind: "gate", stepId: "a", gotoTarget: null, status: "pending", message: "?", requestedAt: run.updatedAt, comment: null, decidedBy: null, decidedVia: null, decider: { by: "human" }, escalated: null, decidedAt: null } as never));
  if (opts.openJob) await store.create({ ...structuredClone(store.get("run_x")!), id: "run_j", status: "running", jobs: [{ id: "j", fromRunId: "run_x", status: "open", batches: [], waiting: [] } as never] });
  const events = async (type: string) => ((runtime as unknown as { bus: { recent: (q: object) => Promise<{ events: Array<{ payload: Record<string, unknown> }> }> } }).bus.recent({ types: [type] })).then((r) => r.events);
  (runtime as unknown as { busyManagers: Set<string> }).busyManagers.clear(); // the fake daemon never ends the manager's turn
  const sweep = async (minutesLater: number) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(store.get("run_x")!.updatedAt) + minutesLater * 60_000);
    await (runtime as unknown as { autoArchiveRuns(): Promise<void> }).autoArchiveRuns();
  };
  return { store, runtime, archived, agentsArchived, sweep, events };
}

const ON = "auto_archive: { enabled: true }\nworkspace: { archive_after: never }\n";

describe("auto_archive", () => {
  it("is off by default: nothing is archived however old the run", async () => {
    const { store, sweep, agentsArchived } = await setup();
    await sweep(100_000);
    expect(store.get("run_x")!.archivedAt).toBeNull();
    expect(agentsArchived).toEqual([]);
  });

  it("archives a finished run and its manager after 30 min, not before, and emits run.auto_archived", async () => {
    const { store, sweep, agentsArchived, events } = await setup({ defaults: ON });
    await sweep(29);
    expect(store.get("run_x")!.archivedAt).toBeNull();
    await sweep(31);
    expect(store.get("run_x")!.archivedAt).not.toBeNull();
    expect(agentsArchived).toEqual(["m"]);
    expect((await events("run.auto_archived")).map((e) => e.payload.runId)).toEqual(["run_x"]);
    expect(store.get("run_x")!.history.some((e) => e.type === "run_auto_archived")).toBe(true);
  });

  it.each(["completed", "failed"] as const)("honours auto_archive.after, for a %s run too", async (status) => {
    const { store, sweep } = await setup({ defaults: "auto_archive: { enabled: true, after: 5m }\nworkspace: { archive_after: never }\n", status });
    await sweep(6);
    expect(store.get("run_x")!.archivedAt).not.toBeNull();
  });

  it("a playbook can switch it on over defaults that leave it off", async () => {
    const { store, sweep } = await setup({ defaults: "workspace: { archive_after: never }\n" });
    expect(store.get("run_x")!.playbook.autoArchive).toEqual({ enabled: false, afterMs: 30 * 60_000, keepFailedWorkspaceMs: 24 * HOURS });
    await sweep(1000);
    expect(store.get("run_x")!.archivedAt).toBeNull();
  });

  it("leaves a run with an open gate, or a hand-off job still open, or a manager in a turn", async () => {
    for (const opts of [{ openGate: true }, { openJob: true }, { managerStatus: "running" }]) {
      const { store, sweep, agentsArchived } = await setup({ defaults: ON, ...opts });
      await sweep(60);
      expect(store.get("run_x")!.archivedAt, JSON.stringify(opts)).toBeNull();
      expect(agentsArchived).toEqual([]);
    }
  });

  it("never archives a workspace holding unpushed commits (the run is archived, the workspace kept, and the event says why)", async () => {
    const { store, sweep, archived, events } = await setup({ defaults: ON, work: "unpushed" });
    await sweep(60);
    expect(archived).toEqual([]);
    expect(store.get("run_x")!.archivedAt).not.toBeNull();
    expect(String((await events("run.auto_archived"))[0]!.payload.workspaceReason)).toContain("not pushed");
  });

  it("archives the workspace with the run when it is safe (archive_with_run)", async () => {
    const { sweep, archived, events } = await setup({ defaults: ON });
    await sweep(60);
    expect(archived).toEqual(["ws"]);
    expect((await events("run.auto_archived"))[0]!.payload.workspaceArchived).toBe(true);
  });

  it("does not archive an agent the plugin did not create as the manager (a restart_run takeOver)", async () => {
    const { store, sweep, agentsArchived } = await setup({ defaults: ON, label: false });
    await sweep(60);
    expect(store.get("run_x")!.archivedAt).not.toBeNull();
    expect(agentsArchived).toEqual([]);
  });

  it("looks into at most 3 runs per tick, and a run that was refused waits before it is tried again", async () => {
    const { store, sweep } = await setup({ defaults: ON, managerStatus: "running" });
    for (const id of ["r2", "r3", "r4", "r5"]) await store.create({ ...structuredClone(store.get("run_x")!), id });
    const refresh = vi.spyOn(Runtime.prototype as never, "autoArchiveRun" as never);
    await sweep(60);
    expect(refresh).toHaveBeenCalledTimes(3);
    await sweep(61);
    expect(refresh).toHaveBeenCalledTimes(5); // the other two; the refused three wait
  });

  describe("failed runs", () => {
    const FAILED = "auto_archive: { enabled: true, after: 5m }\nworkspace: { archive_after: never }\n";
    const sweepWorkspaces = async (store: RunStore, hoursAfter: number) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(store.get("run_x")!.history.findLast((e) => e.type === "run_canceled")!.at) + hoursAfter * HOURS);
      await (runtime as unknown as { autoArchiveFailedWorkspaces(): Promise<void> }).autoArchiveFailedWorkspaces();
    };
    let runtime: Runtime;

    it("a failed run that cannot be restarted loses its workspace after `after`, like a completed one", async () => {
      const ctx = await setup({ defaults: FAILED, status: "failed" });
      await ctx.store.mutate("run_x", (run) => void (run.playbook.steps[0]!.needs = ["nowhere"]));
      await ctx.sweep(6);
      expect(ctx.archived).toEqual(["ws"]);
      expect(workspaceKeptUntilOf(ctx.store)).toBeNull();
    });

    it("a restartable failed run: agents after `after`, workspace only after keep_failed_workspace (default 24h)", async () => {
      const ctx = await setup({ defaults: FAILED, status: "failed" });
      runtime = ctx.runtime;
      await ctx.sweep(6);
      expect(ctx.agentsArchived).toEqual(["m"]);
      expect(ctx.archived).toEqual([]);
      expect(ctx.store.get("run_x")!.archivedAt).not.toBeNull();
      expect(workspaceKeptUntilOf(ctx.store)).not.toBeNull();
      await sweepWorkspaces(ctx.store, 23);
      expect(ctx.archived).toEqual([]);
      await sweepWorkspaces(ctx.store, 25);
      expect(ctx.archived).toEqual(["ws"]);
      expect(ctx.store.get("run_x")!.workspaceArchive).toBe("done");
      expect(workspaceKeptUntilOf(ctx.store)).toBeNull();
    });

    it("keep_failed_workspace is configurable", async () => {
      const ctx = await setup({ defaults: "auto_archive: { enabled: true, after: 5m, keep_failed_workspace: 2h }\nworkspace: { archive_after: never }\n", status: "failed" });
      runtime = ctx.runtime;
      await ctx.sweep(6);
      await sweepWorkspaces(ctx.store, 3);
      expect(ctx.archived).toEqual(["ws"]);
    });

    it("a run restarted in the meantime keeps its workspace", async () => {
      const ctx = await setup({ defaults: FAILED, status: "failed" });
      runtime = ctx.runtime;
      await ctx.sweep(6);
      await ctx.store.mutate("run_x", (run) => void (run.status = "running"));
      await sweepWorkspaces(ctx.store, 100);
      expect(ctx.archived).toEqual([]);
    });

    it("never archives the held workspace while another run in it is active, or when it holds unpushed work", async () => {
      const busy = await setup({ defaults: FAILED, status: "failed" });
      runtime = busy.runtime;
      await busy.sweep(6);
      await busy.store.create({ ...structuredClone(busy.store.get("run_x")!), id: "run_y", status: "running", archivedAt: null });
      await sweepWorkspaces(busy.store, 30);
      expect(busy.archived).toEqual([]);
      const dirty = await setup({ defaults: FAILED, status: "failed", work: "unpushed" });
      runtime = dirty.runtime;
      await dirty.sweep(6);
      await sweepWorkspaces(dirty.store, 30);
      expect(dirty.archived).toEqual([]);
    });

    it("is untouched when auto_archive is off", async () => {
      const ctx = await setup({ defaults: "workspace: { archive_after: never }\n", status: "failed" });
      expect(workspaceKeptUntilOf(ctx.store)).toBeNull();
    });

    it("reports when the workspace is kept until, in list_runs", async () => {
      const ctx = await setup({ defaults: FAILED, status: "failed" });
      const run = ctx.store.get("run_x")!;
      expect(runListing(run).workspaceKeptUntil).toBe(new Date(Date.parse(runEndedAt(run)) + 24 * HOURS).toISOString());
    });
  });
});
