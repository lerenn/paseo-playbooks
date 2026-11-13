import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { runTools } from "./tools";

const exec = promisify(execFile);
const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd })).stdout.trim();
}

const SCRIPTS = ".paseo/plugins/playbooks/scripts";
const script = (word: string) => `#!/bin/sh\necho ${word}\nexit 75\n`;
const ISO = `
title: Probe
isolation: worktree
steps:
  - id: probe
    script: { run: probe.sh, poll: 1s }
    timeout: 5m
`;
const PLAIN = ISO.replace("isolation: worktree\n", "").replace("title: Probe", "title: Plain");

/** A workspace cloned from a bare origin with the playbooks and a probe script (prints `old`, "not yet"). */
async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "refresh-"));
  temps.push(base);
  const origin = path.join(base, "origin.git");
  const dir = path.join(base, "ws");
  await mkdir(origin);
  await git(origin, "init", "-q", "--bare");
  await git(base, "clone", "-q", origin, dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "iso.yaml"), ISO);
  await writeFile(path.join(root, "plain.yaml"), PLAIN);
  await writeFile(path.join(dir, SCRIPTS, "probe.sh"), script("old"), { mode: 0o755 });
  await chmod(path.join(dir, SCRIPTS, "probe.sh"), 0o755);
  await writeFile(path.join(dir, "README.md"), "hi\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "init");
  await git(dir, "branch", "-M", "main");
  await git(dir, "push", "-q", "origin", "main");
  await git(dir, "remote", "set-head", "origin", "main").catch(() => undefined);
  const data = path.join(base, "data");
  const fake = {
    agents: {
      ref: (agentId: string) => ({ refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }), send: async () => undefined, reload: async () => undefined, archive: async () => undefined }),
      list: async () => ({ entries: [] }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: dir }), archive: async () => undefined }) },
  };
  const boot = async () => {
    const store = new RunStore(path.join(data, "runs"));
    await store.init();
    const runtime = new Runtime(store, { autoStartAgents: false });
    runtimes.push(runtime);
    await runtime.attach(fake as never);
    return { store, runtime };
  };
  return { base, origin, dir, data, boot, ...(await boot()) };
}

/** Pushes a script change to origin's main from the workspace clone. */
async function pushScript(dir: string, body: string) {
  await writeFile(path.join(dir, SCRIPTS, "probe.sh"), body);
  await chmod(path.join(dir, SCRIPTS, "probe.sh"), 0o755);
  await git(dir, "commit", "-qam", "fix probe");
  await git(dir, "push", "-q", "origin", "main");
}

const mgr = (dir: string) => ({ id: "m1", workspaceId: "ws", cwd: dir });

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const attemptOf = (store: RunStore, id: string) => store.get(id)!.steps.probe!.attempts.at(-1)!;
/** Waits for `n` more checks to end and returns the last one's output. */
async function nextChecks(store: RunStore, id: string, n: number): Promise<string> {
  const target = attemptOf(store, id).checks + n;
  await until(() => attemptOf(store, id).checks >= target);
  return (attemptOf(store, id).lastMessage ?? "").trim();
}

describe("refresh_scripts", () => {
  it("runs the old script before the refresh and the fixed one after it, without touching the pinned definition or the worktree", async () => {
    const ctx = await setup();
    const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
    expect(await nextChecks(ctx.store, run.id, 1)).toBe("old");
    await pushScript(ctx.dir, script("new"));
    // Not refreshed: the run keeps the script it started with.
    expect(await nextChecks(ctx.store, run.id, 2)).toBe("old");

    const before = structuredClone(ctx.store.get(run.id)!.playbook);
    const worktreeFile = path.join(run.worktree!.path, SCRIPTS, "probe.sh");
    const worktreeBody = await readFile(worktreeFile, "utf8");
    const result = await ctx.runtime.refreshScripts(run.id, "m1");
    expect(result.fromSha).toBe(run.worktree!.baseSha);
    expect(result.toSha).toBe(await git(ctx.dir, "rev-parse", "origin/main"));
    expect(result.changed).toEqual([`${SCRIPTS}/probe.sh`]);

    // A check already running may finish with the old file: the second one after the refresh is the new script.
    expect(await nextChecks(ctx.store, run.id, 2)).toBe("new");
    expect(ctx.store.get(run.id)!.playbook).toEqual(before);
    expect(await readFile(worktreeFile, "utf8")).toBe(worktreeBody);
    expect(await git(run.worktree!.path, "status", "--porcelain")).toBe("");
    // The executable bit survives the export.
    const overlayFile = path.join(ctx.data, "script-overlays", run.id, SCRIPTS, "probe.sh");
    expect((await stat(overlayFile)).mode & 0o111).not.toBe(0);

    const refreshed = ctx.store.get(run.id)!;
    expect(refreshed.scriptsRefresh).toMatchObject({ sha: result.toSha, fromSha: result.fromSha, by: "m1" });
    const event = refreshed.history.find((entry) => entry.type === "scripts_refreshed")!;
    expect(event.detail).toContain(result.fromSha.slice(0, 8));
    expect(event.detail).toContain(result.toSha.slice(0, 8));
  });

  it("survives a restart of the plugin and goes with the worktree", async () => {
    const ctx = await setup();
    const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
    await pushScript(ctx.dir, script("new"));
    await ctx.runtime.refreshScripts(run.id, "m1");
    await ctx.store.close();
    await ctx.runtime.dispose();

    const again = await ctx.boot();
    expect(again.store.get(run.id)!.scriptsRefresh).not.toBeNull();
    await until(() => attemptOf(again.store, run.id).lastMessage?.trim() === "new");

    const overlay = path.join(ctx.data, "script-overlays", run.id);
    expect(existsSync(overlay)).toBe(true);
    await again.store.mutate(run.id, (current) => {
      current.worktree = { ...current.worktree!, state: "removed" };
    });
    await again.runtime.sweepWorktrees();
    expect(existsSync(overlay)).toBe(false);
    // An overlay whose run is gone is swept too.
    await mkdir(path.join(ctx.data, "script-overlays", "run_gone"), { recursive: true });
    await again.runtime.sweepWorktrees();
    expect(existsSync(path.join(ctx.data, "script-overlays", "run_gone"))).toBe(false);
  });

  it("never runs a script the pinned definition does not name", async () => {
    const ctx = await setup();
    const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
    await writeFile(path.join(ctx.dir, SCRIPTS, "extra.sh"), script("extra"));
    await chmod(path.join(ctx.dir, SCRIPTS, "extra.sh"), 0o755);
    await git(ctx.dir, "add", ".");
    await git(ctx.dir, "commit", "-qm", "extra");
    await git(ctx.dir, "push", "-q", "origin", "main");
    const result = await ctx.runtime.refreshScripts(run.id, "m1");
    expect(result.changed).toContain(`${SCRIPTS}/extra.sh`);
    expect(Object.keys(ctx.store.get(run.id)!.steps)).toEqual(["probe"]);
    expect(await nextChecks(ctx.store, run.id, 2)).toBe("old");
  });

  describe("refusals", () => {
    it("a run without isolation", async () => {
      const ctx = await setup();
      const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "plain", {});
      await expect(ctx.runtime.refreshScripts(run.id)).rejects.toThrow(/not isolated.*live workspace checkout/);
      expect(ctx.store.get(run.id)!.scriptsRefresh).toBeNull();
    });

    it("a worktree that changed a script itself, naming it", async () => {
      const ctx = await setup();
      const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
      await pushScript(ctx.dir, script("new"));
      await writeFile(path.join(run.worktree!.path, SCRIPTS, "probe.sh"), script("mine"));
      await expect(ctx.runtime.refreshScripts(run.id)).rejects.toThrow(new RegExp(`changed script\\(s\\) itself.*${SCRIPTS}/probe.sh`));
      expect(existsSync(path.join(ctx.data, "script-overlays", run.id))).toBe(false);
      expect(ctx.store.get(run.id)!.scriptsRefresh).toBeNull();
    });

    it("a failed git diff of the worktree is a refusal with the git error, not a skipped check", async () => {
      const ctx = await setup();
      const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
      await pushScript(ctx.dir, script("new"));
      await ctx.store.mutate(run.id, (current) => {
        current.worktree!.baseSha = "0".repeat(40);
      });
      await expect(ctx.runtime.refreshScripts(run.id)).rejects.toThrow(/could not check whether run .* changed scripts \(git diff failed: [\s\S]+\)[\s\S]*previous scripts/);
      expect(existsSync(path.join(ctx.data, "script-overlays", run.id))).toBe(false);
      expect(ctx.store.get(run.id)!.scriptsRefresh).toBeNull();
    });

    it("a failed fetch, reporting the error and keeping the previous scripts", async () => {
      const ctx = await setup();
      const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
      await pushScript(ctx.dir, script("new"));
      await ctx.runtime.refreshScripts(run.id, "m1");
      await nextChecks(ctx.store, run.id, 2);
      const sha = ctx.store.get(run.id)!.scriptsRefresh!.sha;
      await pushScript(ctx.dir, script("newer"));
      await git(ctx.dir, "remote", "set-url", "origin", path.join(ctx.base, "missing.git"));
      await expect(ctx.runtime.refreshScripts(run.id)).rejects.toThrow(/could not fetch origin\/main: .*the run keeps its previous scripts/);
      expect(ctx.store.get(run.id)!.scriptsRefresh!.sha).toBe(sha);
      expect(await nextChecks(ctx.store, run.id, 2)).toBe("new");
    });

    it("an ended or unknown run", async () => {
      const ctx = await setup();
      const run = await ctx.runtime.startPlaybook(mgr(ctx.dir), "iso", {});
      await ctx.runtime.cancelRun(run.id, "done", null);
      await expect(ctx.runtime.refreshScripts(run.id)).rejects.toThrow(/is canceled/);
      await expect(ctx.runtime.refreshScripts("run_nope")).rejects.toThrow(/unknown run/);
    });
  });

  it("is a registered run tool that returns the commits", async () => {
    const calls: Array<[string, string | null]> = [];
    const runtime = {
      refreshScripts: async (runId: string, by: string | null) => {
        calls.push([runId, by]);
        return { fromSha: "a".repeat(40), toSha: "b".repeat(40), changed: ["x/scripts/s.sh"], missing: [], unchanged: false };
      },
    } as unknown as Runtime;
    const tool = runTools(runtime).find((candidate) => candidate.name === "refresh_scripts") as unknown as { execute: (input: unknown, ctx: unknown) => Promise<{ text: string; isError?: boolean }> };
    expect(tool).toBeDefined();
    const result = await tool.execute({ runId: "run_a" }, { agent: { id: "m1" } });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("aaaaaaaa -> bbbbbbbb");
    expect(result.text).toContain("x/scripts/s.sh");
    expect(calls).toEqual([["run_a", "m1"]]);
  });
});
