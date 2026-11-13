import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime, MANAGER_TOOL_NAMES } from "./runtime";
import { RunStore } from "./store";
import { SIDEKICK_PLUGIN_TOOLS } from "./sidekick";
import { managerTools, runTools } from "./tools";

const exec = promisify(execFile);
const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const dir of temps.splice(0)) {
    await exec("chmod", ["-R", "u+rwx", dir]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd })).stdout.trim();
}

const PLAYBOOK = (isolation: string) => `
title: Wait
${isolation}
steps:
  - id: wait_merge
    script: { run: wait.sh, poll: 1s }
    timeout: 1m
    outputs: { merged_sha: {} }
`;

/** The script: records its version in $MARK on every check, and never finishes ("not yet", exit 75). */
const script = (version: string, mark: string) => `#!/bin/sh\necho ${version} >> ${mark}\nexit 75\n`;

const REL = ".paseo/plugins/playbooks";

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "refresh-"));
  temps.push(base);
  const origin = path.join(base, "origin.git");
  const dir = path.join(base, "ws");
  const mark = path.join(base, "marker");
  await mkdir(origin);
  await git(origin, "init", "-q", "--bare");
  await git(base, "clone", "-q", origin, dir);
  const root = path.join(dir, REL);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, REL, "roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "iso.yaml"), PLAYBOOK("isolation: worktree"));
  await writeFile(path.join(root, "plain.yaml"), PLAYBOOK(""));
  await writeFile(path.join(root, "scripts/wait.sh"), script("v1", mark));
  await chmod(path.join(root, "scripts/wait.sh"), 0o755);
  await git(dir, "add", REL);
  await git(dir, "commit", "-qm", "init");
  await git(dir, "branch", "-M", "main");
  await git(dir, "push", "-q", "origin", "main");
  await git(dir, "remote", "set-head", "origin", "main").catch(() => undefined);

  const agents = new Set<string>();
  const paseo = {
    agents: {
      ref: (agentId: string) => ({ refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }), send: async () => undefined, reload: async () => undefined, archive: async () => undefined }),
      list: async () => ({ entries: [...agents].map((id) => ({ agent: { id, labels: {}, archivedAt: null, status: "idle" } })) }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: dir }), agents: { create: async () => ({ id: "m", send: async () => undefined }) }, archive: async () => undefined }) },
  };
  const storeDir = path.join(base, "data", "runs");
  const store = new RunStore(storeDir);
  await store.init();
  const open = async (s: RunStore) => {
    const runtime = new Runtime(s, { autoStartAgents: false, pollMs: 3_600_000 });
    runtimes.push(runtime);
    await runtime.attach(paseo as never);
    return runtime;
  };
  const runtime = await open(store);
  const start = (playbook = "iso") => runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: dir }, playbook, {});
  /** Commits a new version of the script to origin/main (through the workspace clone). */
  const publish = async (version: string) => {
    await writeFile(path.join(root, "scripts/wait.sh"), script(version, mark));
    await git(dir, "add", REL);
    await git(dir, "commit", "-qm", `script ${version}`);
    await git(dir, "push", "-q", "origin", "main");
    return git(dir, "rev-parse", "HEAD");
  };
  const versions = async () => ((await readFile(mark, "utf8").catch(() => "")).trim().split("\n").filter(Boolean));
  const lastVersion = async () => (await versions()).at(-1);
  /** Waits for the next check to have run, and returns its script version. */
  const nextCheck = async () => {
    const seen = (await versions()).length;
    const end = Date.now() + 8000;
    while ((await versions()).length <= seen) {
      if (Date.now() > end) throw new Error("no check ran");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return lastVersion();
  };
  return { base, dir, origin, store, storeDir, runtime, open, start, publish, nextCheck, mark };
}

describe("refresh_scripts: tools", () => {
  const runtime = {} as Runtime;
  it("is a common run tool, listed for managers and the Sidekick, and not a manager-only tool", () => {
    expect(runTools(runtime).map((tool) => tool.name)).toContain("refresh_scripts");
    expect(managerTools(runtime).map((tool) => tool.name)).not.toContain("refresh_scripts");
    expect(MANAGER_TOOL_NAMES).toContain("refresh_scripts");
    expect(SIDEKICK_PLUGIN_TOOLS).toContain("refresh_scripts");
  });
});

describe("refresh_scripts", () => {
  it("runs a script fixed on main after the run started only once refreshed, with the step definition pinned", async () => {
    const ctx = await setup();
    const run = await ctx.start();
    expect(await ctx.nextCheck()).toBe("v1");
    const fixedSha = await ctx.publish("v2");
    // Not before the refresh.
    expect(await ctx.nextCheck()).toBe("v1");
    const pinned = JSON.stringify(ctx.store.get(run.id)!.playbook);

    const result = await ctx.runtime.refreshScripts(run.id, "the v2 fix", "agent-x");
    expect(result).toMatchObject({ ref: "origin/main", sha: fixedSha, before: null, changed: true });
    expect(await ctx.nextCheck()).toBe("v2");
    const after = ctx.store.get(run.id)!;
    expect(JSON.stringify(after.playbook)).toBe(pinned);
    expect(after.playbook.steps[0]).toMatchObject({ id: "wait_merge", script: `${REL}/scripts/wait.sh`, pollMs: 1000, timeoutMs: 60_000, outputs: { merged_sha: expect.anything() } });
    expect(after.scripts).toMatchObject({ sha: fixedSha, dir: path.join(ctx.base, "data", "run-scripts", run.id) });
    const event = after.history.find((entry) => entry.type === "scripts_refreshed")!;
    expect(event.detail).toContain(`-> ${fixedSha}`);
    expect(event.detail).toContain(run.worktree!.baseSha);
    expect(event.detail).toContain("the v2 fix");
    expect(event.detail).toContain("agent-x");
  });

  it("is idempotent for the same commit, and picks up a newer one", async () => {
    const ctx = await setup();
    const run = await ctx.start();
    const first = await ctx.runtime.refreshScripts(run.id, "a", "x");
    expect(first.changed).toBe(true);
    const again = await ctx.runtime.refreshScripts(run.id, "b", "x");
    expect(again).toMatchObject({ changed: false, sha: first.sha });
    expect(ctx.store.get(run.id)!.history.filter((entry) => entry.type === "scripts_refreshed")).toHaveLength(1);
    const next = await ctx.publish("v3");
    expect(await ctx.runtime.refreshScripts(run.id, "c", "x")).toMatchObject({ changed: true, before: first.sha, sha: next });
  });

  it("refuses, writing nothing, an unknown run, an ended run, a run without a worktree, a bare-branch base and a failing fetch", async () => {
    const ctx = await setup();
    const runsScripts = path.join(ctx.base, "data", "run-scripts");
    const expectUntouched = async (id: string) => {
      expect(existsSync(path.join(runsScripts, id))).toBe(false);
      expect(ctx.store.get(id)?.scripts ?? null).toBeNull();
      expect(ctx.store.get(id)?.history.some((entry) => entry.type === "scripts_refreshed") ?? false).toBe(false);
    };

    await expect(ctx.runtime.refreshScripts("run_nope", "x", "a")).rejects.toThrow(/unknown run/);

    const plain = await ctx.start("plain");
    await expect(ctx.runtime.refreshScripts(plain.id, "x", "a")).rejects.toThrow(/no worktree/);
    await expectUntouched(plain.id);
    await ctx.runtime.cancelRun(plain.id, "x", null);

    const bare = await ctx.start();
    await ctx.store.mutate(bare.id, (current) => void (current.worktree = { ...current.worktree!, base: "main" }));
    await expect(ctx.runtime.refreshScripts(bare.id, "x", "a")).rejects.toThrow(/not from origin\/<branch>/);
    await expectUntouched(bare.id);
    await ctx.runtime.cancelRun(bare.id, "x", null);

    const ended = await ctx.start();
    await ctx.runtime.cancelRun(ended.id, "x", null);
    await expect(ctx.runtime.refreshScripts(ended.id, "x", "a")).rejects.toThrow(/has ended/);
    await expectUntouched(ended.id);

    const broken = await ctx.start();
    await git(ctx.dir, "remote", "set-url", "origin", path.join(ctx.base, "gone.git"));
    await expect(ctx.runtime.refreshScripts(broken.id, "x", "a")).rejects.toThrow(/could not fetch origin\/main/);
    await expectUntouched(broken.id);
  });

  it("survives a restart, and is removed with the worktree (cleanup, sweep) and with the run (workspace archived)", async () => {
    const ctx = await setup();
    const run = await ctx.start();
    await ctx.runtime.refreshScripts(run.id, "x", "a");
    const dir = ctx.store.get(run.id)!.scripts!.dir;
    expect(existsSync(path.join(dir, REL, "scripts/wait.sh"))).toBe(true);

    // A new runtime on the same store directory still has the record.
    const reopened = new RunStore(ctx.storeDir);
    await reopened.init();
    expect(reopened.get(run.id)!.scripts).toMatchObject({ dir });

    // A recreated worktree keeps the refreshed copy.
    await rm(run.worktree!.path, { recursive: true, force: true });
    await git(ctx.dir, "worktree", "prune");
    const recreated = await (ctx.runtime as unknown as { ensureWorktree(run: unknown, dir: string): Promise<{ state: string } | null> }).ensureWorktree(ctx.store.get(run.id)!, ctx.dir);
    expect(recreated).toMatchObject({ state: "active" });
    expect(ctx.store.get(run.id)!.scripts).toMatchObject({ dir });
    expect(existsSync(dir)).toBe(true);

    // The ended run's worktree cleanup removes the copy.
    await ctx.runtime.cancelRun(run.id, "done", null);
    await (ctx.runtime as unknown as { cleanupEndedWorktrees(): Promise<void> }).cleanupEndedWorktrees();
    expect(ctx.store.get(run.id)!.worktree!.state).toBe("removed");
    expect(existsSync(dir)).toBe(false);
    expect(ctx.store.get(run.id)!.scripts).toBeNull();

    // The orphan sweep removes a copy whose run is gone or whose worktree was removed.
    await mkdir(path.join(ctx.base, "data", "run-scripts", "run_orphan"), { recursive: true });
    await mkdir(path.join(dir, REL), { recursive: true });
    await ctx.runtime.sweepWorktrees();
    expect(existsSync(path.join(ctx.base, "data", "run-scripts", "run_orphan"))).toBe(false);
    expect(existsSync(dir)).toBe(false);

    // Deleting the run (workspace archived) removes it too.
    const second = await ctx.start();
    await ctx.runtime.refreshScripts(second.id, "x", "a");
    const secondDir = ctx.store.get(second.id)!.scripts!.dir;
    await ctx.runtime.onWorkspaceArchived("ws");
    expect(ctx.store.get(second.id)).toBeUndefined();
    expect(existsSync(secondDir)).toBe(false);
  });
});
