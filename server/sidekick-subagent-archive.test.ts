import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSidekick } from "./loader";
import { Runtime } from "./runtime";
import { sidekickPrompt, SIDEKICK_PASEO_TOOLS } from "./sidekick";
import { RunStore } from "./store";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PLAYBOOKS = ".paseo/plugins/playbooks";
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(10);
}

type Ws = { workspaceKind: string; background: boolean; worktreeSlug?: string; workspaceDirectory: string };
type Ag = { workspaceId: string; status: string; parentAgentId: string | null; archivedAt: string | null; pendingPermissions: unknown[] };

/** A project with a Sidekick, a real clone as the subagent's worktree (so dirty and unpushed are real git states), and a fake daemon. */
async function setup(options: { sidekickYaml?: string; afterMs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sk-archive-"));
  temps.push(dir);
  const root = path.join(dir, "shop");
  await mkdir(path.join(root, PLAYBOOKS, "sidekick"), { recursive: true });
  await writeFile(path.join(root, PLAYBOOKS, "sidekick/instructions.md"), "Rules.\n");
  if (options.sidekickYaml) await writeFile(path.join(root, PLAYBOOKS, "sidekick/sidekick.yaml"), options.sidekickYaml);
  // A bare remote and a clone of it: the clone is the subagent's worktree.
  const bare = path.join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = path.join(dir, "seed");
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "pipe" });
  sh(seed, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(seed, "push", "-q", "origin", "HEAD:main");
  const wtDir = path.join(dir, "wt");
  execFileSync("git", ["clone", "-q", bare, wtDir], { stdio: "pipe" });

  const workspaces: Record<string, Ws | null> = {
    "ws-shop": { workspaceKind: "local_checkout", background: false, workspaceDirectory: root },
    "side-shop": { workspaceKind: "directory", background: true, workspaceDirectory: root },
    "wt-1": { workspaceKind: "worktree", background: true, worktreeSlug: "wt", workspaceDirectory: wtDir },
  };
  const agents: Record<string, Ag> = {};
  const archivedAgents: string[] = [];
  const archivedWorkspaces: string[] = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const idle = (workspaceId: string, parentAgentId: string | null = null): Ag => ({ workspaceId, status: "idle", parentAgentId, archivedAt: null, pendingPermissions: [] });
  const describeWs = (id: string) => {
    const ws = workspaces[id];
    return ws ? { id, projectId: "shop", projectDisplayName: "Shop", projectRootPath: root, ...ws } : null;
  };
  const agentRef = (id: string) => ({
    refresh: async () => (agents[id] ? { agent: { id, ...agents[id] } } : null),
    send: async (text: string) => void sent.push({ agentId: id, text }),
    archive: async () => {
      archivedAgents.push(id);
      if (agents[id]) agents[id]!.archivedAt = "now";
    },
  });
  const paseo = {
    agents: {
      ref: agentRef,
      list: async () => ({ entries: Object.entries(agents).map(([id, agent]) => ({ agent: { id, internal: false, ...agent } })) }),
    },
    workspaces: {
      ref: (id: string) => ({
        id,
        refresh: async () => describeWs(id),
        archive: async () => void (archivedWorkspaces.push(id), (workspaces[id] = null)),
        agents: {
          create: async () => {
            agents["agent-1"] = idle(id);
            return { id: "agent-1", ...agentRef("agent-1") };
          },
        },
      }),
      create: async () => ({ id: "side-shop", agents: { create: async () => ((agents["agent-1"] = idle("side-shop")), { id: "agent-1", ...agentRef("agent-1") }) } }),
    },
  };
  const dataDir = path.join(dir, "data");
  const store = new RunStore(path.join(dataDir, "runs"));
  await store.init();
  const start = async (afterMs = options.afterMs ?? 40) => {
    const runtime = new Runtime(store, { dataDir, subagentArchiveAfterMs: afterMs });
    runtimes.push(runtime);
    await runtime.attach(paseo as never);
    return runtime;
  };
  const runtime = await start();
  await runtime.openSidekick("ws-shop");
  /** A subagent of the Sidekick in `workspaceId` finishes while the Sidekick is idle: it is told at once. */
  const finish = async (rt: Runtime = runtime, id = "sub-1", workspaceId = "wt-1") => {
    agents[id] ??= idle(workspaceId, "agent-1");
    await rt.onTurnEnded(id, "completed", "agent-1");
  };
  return { dir, root, wtDir, workspaces, agents, archivedAgents, archivedWorkspaces, sent, runtime, runtimes: start, finish, store, idle, dataDir };
}

describe("archiving the workspace of a Sidekick subagent", () => {
  it("drops the cached workspace list when it archives the workspace", async () => {
    const ctx = await setup({ afterMs: 150 });
    const invalidate = vi.spyOn((ctx.runtime as unknown as { workspaces: { invalidate(): void } }).workspaces, "invalidate");
    await ctx.finish();
    await until(() => ctx.archivedWorkspaces.length > 0);
    expect(invalidate).toHaveBeenCalled();
  });

  it("archives the subagent and its workspace after the grace period, not before", async () => {
    const ctx = await setup({ afterMs: 150 });
    await ctx.finish();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.archivedWorkspaces).toEqual([]);
    await until(() => ctx.archivedWorkspaces.length > 0);
    expect(ctx.archivedWorkspaces).toEqual(["wt-1"]);
    expect(ctx.archivedAgents).toContain("sub-1");
  });

  it("waits until the Sidekick has been told: a notice held for a busy Sidekick starts the grace when it is delivered", async () => {
    const ctx = await setup({ afterMs: 30 });
    ctx.agents["agent-1"]!.status = "running";
    await ctx.finish();
    await sleep(120);
    expect(ctx.archivedWorkspaces).toEqual([]);
    ctx.agents["agent-1"]!.status = "idle";
    await ctx.runtime.onTurnEnded("agent-1", "completed");
    await until(() => ctx.archivedWorkspaces.length > 0);
    expect(ctx.archivedWorkspaces).toEqual(["wt-1"]);
  });

  it("uses the grace period of sidekick.subagents.archive_after", async () => {
    const ctx = await setup({ sidekickYaml: "sidekick:\n  subagents: { archive_after: 1h }\n", afterMs: 10 });
    await ctx.finish();
    const [entry] = JSON.parse(await readFile(path.join(ctx.dataDir, "sidekick-archive.json"), "utf8"));
    expect(entry.dueAt - Date.now()).toBeGreaterThan(59 * 60_000);
    await sleep(80);
    expect(ctx.archivedWorkspaces).toEqual([]);
  });

  it("is off with sidekick.subagents.archive_workspace: false", async () => {
    const ctx = await setup({ sidekickYaml: "sidekick:\n  subagents: { archive_workspace: false }\n" });
    await ctx.finish();
    await sleep(120);
    expect(ctx.archivedWorkspaces).toEqual([]);
    await expect(readFile(path.join(ctx.dataDir, "sidekick-archive.json"), "utf8")).rejects.toThrow();
  });

  it("is off when the setting is turned off during the grace period", async () => {
    const ctx = await setup({ afterMs: 100 });
    await ctx.finish();
    await writeFile(path.join(ctx.root, PLAYBOOKS, "sidekick/sidekick.yaml"), "sidekick:\n  subagents: { archive_workspace: false }\n");
    await sleep(250);
    expect(ctx.archivedWorkspaces).toEqual([]);
  });

  describe("guards", () => {
    const kept = async (ctx: Awaited<ReturnType<typeof setup>>) => {
      await ctx.finish();
      await until(() => false, 200);
      expect(ctx.archivedWorkspaces).toEqual([]);
      expect(ctx.archivedAgents).toEqual([]);
    };

    it("never archives the project's root checkout, even as a background worktree-looking workspace", async () => {
      const ctx = await setup();
      // The Sidekick called create_agent without workspaceId: the subagent is in the root checkout.
      ctx.workspaces["ws-shop"] = { workspaceKind: "local_checkout", background: false, workspaceDirectory: ctx.root };
      await ctx.finish(ctx.runtime, "sub-1", "ws-shop");
      await sleep(150);
      expect(ctx.archivedWorkspaces).toEqual([]);
      // Even if the daemon reported it as a hidden worktree, the directory is the project root.
      ctx.workspaces["ws-shop"] = { workspaceKind: "worktree", background: true, worktreeSlug: "x", workspaceDirectory: ctx.root };
      await ctx.finish(ctx.runtime, "sub-1", "ws-shop");
      await sleep(150);
      expect(ctx.archivedWorkspaces).toEqual([]);
    });

    it("never archives a visible workspace, a directory or the Sidekick's own workspace", async () => {
      const ctx = await setup();
      ctx.workspaces["wt-1"]!.background = false;
      await kept(ctx);
      const other = await setup();
      other.workspaces["wt-1"]!.workspaceKind = "directory";
      await kept(other);
      const own = await setup();
      await own.finish(own.runtime, "sub-1", "side-shop");
      await sleep(150);
      expect(own.archivedWorkspaces).toEqual([]);
    });

    it("never archives a run's workspace", async () => {
      const ctx = await setup();
      const pbRoot = path.join(ctx.dir, ".paseo/playbooks");
      await cp(path.resolve(__dirname, "..", "examples/.paseo/plugins/playbooks/roles"), path.join(pbRoot, "roles"), { recursive: true });
      await writeFile(path.join(pbRoot, "main.yaml"), "title: Main\nsteps:\n  - id: a\n    role: { name: implementer }\n");
      const { entries } = await loadPlaybooks(ctx.dir);
      const playbook = entries.find((candidate) => candidate.id === "main")?.playbook;
      if (!playbook) throw new Error("playbook did not load");
      await ctx.store.create(newRun({ id: "run_x", playbook, workspaceId: "wt-1", workspaceDir: ctx.wtDir, projectId: "shop", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() }));
      await kept(ctx);
    });

    it("keeps a workspace where another live agent works", async () => {
      const ctx = await setup();
      ctx.agents["human-agent"] = ctx.idle("wt-1");
      await kept(ctx);
    });

    it("keeps a workspace with uncommitted changes", async () => {
      const ctx = await setup();
      await writeFile(path.join(ctx.wtDir, "notes.txt"), "unsaved");
      await kept(ctx);
    });

    it("keeps a workspace whose branch has commits that are not pushed", async () => {
      const ctx = await setup();
      sh(ctx.wtDir, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "local only");
      await kept(ctx);
    });

    it("archives a workspace whose commits are pushed", async () => {
      const ctx = await setup({ afterMs: 30 });
      sh(ctx.wtDir, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "pushed");
      sh(ctx.wtDir, "push", "-q", "origin", "HEAD:refs/heads/work");
      await ctx.finish();
      await until(() => ctx.archivedWorkspaces.length > 0);
      expect(ctx.archivedWorkspaces).toEqual(["wt-1"]);
    });

    it("keeps a workspace whose subagent is running again or waits on a permission", async () => {
      const ctx = await setup({ afterMs: 60 });
      await ctx.finish();
      ctx.agents["sub-1"]!.status = "running";
      await sleep(200);
      expect(ctx.archivedWorkspaces).toEqual([]);
      const waiting = await setup({ afterMs: 60 });
      await waiting.finish();
      waiting.agents["sub-1"]!.pendingPermissions = [{ id: "p" }];
      await sleep(200);
      expect(waiting.archivedWorkspaces).toEqual([]);
    });

    it("only handles subagents of the Sidekick", async () => {
      const ctx = await setup();
      ctx.agents["sub-1"] = ctx.idle("wt-1", "someone-else");
      await ctx.runtime.onTurnEnded("sub-1", "completed", "someone-else");
      await sleep(150);
      expect(ctx.archivedWorkspaces).toEqual([]);
    });
  });

  describe("after a restart", () => {
    it("archives at the saved time: the pending archive is read again, not lost and not early", async () => {
      const ctx = await setup({ afterMs: 3_600_000 });
      await ctx.finish();
      await ctx.runtime.dispose();
      const early = await ctx.runtimes(3_600_000);
      await sleep(100);
      expect(ctx.archivedWorkspaces).toEqual([]);
      await early.dispose();
      const file = path.join(ctx.dataDir, "sidekick-archive.json");
      const [entry] = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify([{ ...entry, dueAt: Date.now() + 80 }]));
      await ctx.runtimes(3_600_000);
      await sleep(30);
      expect(ctx.archivedWorkspaces).toEqual([]);
      await until(() => ctx.archivedWorkspaces.length > 0);
      expect(ctx.archivedWorkspaces).toEqual(["wt-1"]);
      await sleep(100);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
    });

    it("archives at once an entry that came due while the plugin was down", async () => {
      const ctx = await setup({ afterMs: 3_600_000 });
      await ctx.finish();
      await ctx.runtime.dispose();
      const file = path.join(ctx.dataDir, "sidekick-archive.json");
      const [entry] = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify([{ ...entry, dueAt: Date.now() - 1000 }]));
      await ctx.runtimes();
      await until(() => ctx.archivedWorkspaces.length > 0);
      expect(ctx.archivedWorkspaces).toEqual(["wt-1"]);
    });
  });
});

describe("the Sidekick's rules for its subagents' workspaces", () => {
  const prompt = (setting?: { archive: boolean; afterMs: number }) => sidekickPrompt({ projectId: "p", label: "Shop", root: "/work/shop", watch: [], ...(setting ? { subagentWorkspace: setting } : {}) }, null);

  it("creates a hidden worktree workspace first and never calls create_agent without a workspaceId", () => {
    const text = prompt();
    expect(text).toContain('create_workspace { isolation: "worktree", background: true, path: "/work/shop" }');
    expect(text).toContain("NEVER call create_agent without a workspaceId");
    expect(SIDEKICK_PASEO_TOOLS).toContain("create_workspace");
  });

  it("says when the plugin archives the workspace, and says nothing of it when it is off", () => {
    expect(prompt({ archive: true, afterMs: 30 * 60_000 })).toContain("about 30 minutes after");
    expect(prompt()).toContain("about 10 minutes after");
    expect(prompt({ archive: false, afterMs: 600_000 })).not.toContain("archives such a hidden workspace");
  });
});

describe("sidekick.subagents.archive_workspace and archive_after", () => {
  const load = async (yaml: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sk-load-"));
    temps.push(dir);
    await mkdir(path.join(dir, PLAYBOOKS, "sidekick"), { recursive: true });
    await writeFile(path.join(dir, PLAYBOOKS, "sidekick/sidekick.yaml"), yaml);
    return loadSidekick(dir);
  };

  it("reads both, next to provider and model", async () => {
    const result = await load("sidekick:\n  subagents: { provider: claude, archive_workspace: false, archive_after: 30m }\n");
    expect(result.errors).toEqual([]);
    expect(result.config?.subagents).toEqual({ provider: "claude", archiveWorkspace: false, archiveAfterMs: 30 * 60_000 });
  });

  it("refuses a bad or too long duration", async () => {
    expect((await load("sidekick:\n  subagents: { archive_after: soon }\n")).errors.join("\n")).toContain("archive_after");
    expect((await load("sidekick:\n  subagents: { archive_after: 48h }\n")).errors.join("\n")).toContain("at most 24h");
  });
});
