import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { removedGitlinks } from "./git";
import { definitionNote } from "./tools";
import { resolveForNewRun } from "./fresh";
import { loadPlaybooks } from "./loader";
import { GIT_STAGING_RULE, stepSystemPrompt, worktreePreamble, withWorktree } from "./prompts";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { createWorktree, removeWorktree, hasUnpushedCommits } from "./worktree";

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
  return (await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd })).stdout.trim();
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  temps.push(dir);
  return dir;
}

/** A workspace checkout cloned from a bare origin, with `files` committed and pushed to main. */
async function workspace(files: Record<string, string> = {}, extra?: (dir: string, origin: string) => Promise<void>) {
  const base = await tmp("iso");
  const origin = path.join(base, "origin.git");
  const dir = path.join(base, "ws");
  await mkdir(origin);
  await git(origin, "init", "-q", "--bare");
  await git(base, "clone", "-q", origin, dir);
  await writeFile(path.join(dir, "README.md"), "hello\n");
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  await extra?.(dir, origin);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "init");
  await git(dir, "branch", "-M", "main");
  await git(dir, "push", "-q", "origin", "main");
  await git(dir, "remote", "set-head", "origin", "main").catch(() => undefined);
  return { base, origin, dir, worktrees: path.join(base, "data", "worktrees") };
}

describe("isolation: loading", () => {
  async function load(playbook: string, defaults?: string) {
    const dir = await tmp("iso-load");
    const root = path.join(dir, ".paseo/plugins/playbooks");
    await mkdir(root, { recursive: true });
    await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
    if (defaults) {
      await mkdir(path.join(root, "defaults"), { recursive: true });
      await writeFile(path.join(root, "defaults/main.yaml"), defaults);
    }
    await writeFile(path.join(root, "main.yaml"), playbook);
    return (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "main")!;
  }
  const STEP = "steps:\n  - id: a\n    role: { name: implementer, prompt: \"Work in {{ worktree }}\" }\n";

  it("defaults to none, so existing playbooks are unchanged", async () => {
    const entry = await load(`title: P\n${STEP}`);
    expect(entry.errors).toEqual([]);
    expect(entry.playbook!.isolation).toEqual({ mode: "none", submodules: "none", base: null, allowGitlinkRemoval: false });
  });

  it("accepts the short form, the block, and defaults merged field by field", async () => {
    expect((await load(`title: P\nisolation: worktree\n${STEP}`)).playbook!.isolation).toEqual({ mode: "worktree", submodules: "none", base: null, allowGitlinkRemoval: false });
    const block = await load(`title: P\nisolation: { mode: worktree, submodules: [ops/a, ops/b], base: develop }\n${STEP}`);
    expect(block.playbook!.isolation).toEqual({ mode: "worktree", submodules: ["ops/a", "ops/b"], base: "develop", allowGitlinkRemoval: false });
    const merged = await load(`title: P\nisolation: { submodules: all }\n${STEP}`, "isolation: { mode: worktree, base: trunk }\n");
    expect(merged.errors).toEqual([]);
    expect(merged.playbook!.isolation).toEqual({ mode: "worktree", submodules: "all", base: "trunk", allowGitlinkRemoval: false });
    const off = await load(`title: P\nisolation: none\n${STEP}`, "isolation: worktree\n");
    expect(off.playbook!.isolation.mode).toBe("none");
  });

  it("reads isolation.allow_gitlink_removal (default false)", async () => {
    const on = await load(`title: P\nisolation: { mode: worktree, allow_gitlink_removal: true }\n${STEP}`);
    expect(on.errors).toEqual([]);
    expect(on.playbook!.isolation.allowGitlinkRemoval).toBe(true);
    const viaDefault = await load(`title: P\nisolation: worktree\n${STEP}`, "isolation: { allow_gitlink_removal: true }\n");
    expect(viaDefault.playbook!.isolation.allowGitlinkRemoval).toBe(true);
    expect((await load(`title: P\nisolation: { mode: worktree, allow_gitlink_removal: yes please }\n${STEP}`)).errors.join("\n")).toMatch(/isolation/);
  });

  it("refuses a mistyped key, an unknown mode and a singleton that asks for a worktree; a default never reaches a singleton", async () => {
    expect((await load(`title: P\nisolation: { mode: worktree, submodule: all }\n${STEP}`)).errors.join("\n")).toMatch(/isolation/);
    expect((await load(`title: P\nisolation: shared\n${STEP}`)).errors.join("\n")).toMatch(/isolation/);
    const singleton = `title: P\nsingleton: {}\nsteps:\n  - id: a\n    role: { name: reviewer }\n`;
    expect((await load(`isolation: worktree\n${singleton}`)).errors.join("\n")).toMatch(/does not apply to a singleton/);
    const viaDefault = await load(singleton, "isolation: worktree\n");
    expect(viaDefault.errors).toEqual([]);
    expect(viaDefault.playbook!.isolation.mode).toBe("none");
  });
});

describe("worktree preamble", () => {
  const run = { workspaceDir: "/ws", worktree: { path: "/data/worktrees/run_a", branch: "playbooks/p-a", base: "origin/main", baseSha: "x", linked: ["ops/x"], workspaceSnapshot: null, state: "active" as const } };

  it("names the worktree, how to run commands, absolute paths and the forbidden checkout; nothing for a plain run", () => {
    const text = worktreePreamble(run);
    expect(text).toContain("/data/worktrees/run_a");
    expect(text).toMatch(/cd \/data\/worktrees\/run_a && /);
    expect(text).toMatch(/git -C \/data\/worktrees\/run_a/);
    expect(text).toMatch(/absolute paths/);
    expect(text).toMatch(/Never edit, create or delete files in \/ws/);
    expect(text).toContain("ops/x");
    expect(text).toMatch(/Never use `git stash`.*temporary WIP commit/s);
    expect(text).toMatch(/Never run `git checkout`, `git reset` or `git pull`/);
    expect(text).toMatch(/Never run `git add -A`, `git add \.` or `git commit -a`\/`-am`.*git add <path>.*git diff --cached --stat/s);
    expect(text).toMatch(/delete mode 160000.*git restore --staged/s);
    expect(worktreePreamble({ workspaceDir: "/ws", worktree: null })).toBe("");
  });

  it("gives step agents the staging rule once: in the preamble when isolated, on its own otherwise", () => {
    const playbook = { title: "P" } as never;
    const step = { id: "a", outcomes: ["success"], outputs: {} } as never;
    const role = { title: "R", instructions: "Do it.", readonly: false } as never;
    const plain = stepSystemPrompt(playbook, step, role);
    expect(plain).toContain(GIT_STAGING_RULE);
    const isolated = stepSystemPrompt(playbook, step, role, run);
    expect(isolated.split(GIT_STAGING_RULE).length - 1).toBe(1);
  });

  it("renders {{ worktree }}: the worktree, else the workspace; other placeholders stay", () => {
    expect(withWorktree("cd {{ worktree }} {{ inputs.x }}", run)).toBe("cd /data/worktrees/run_a {{ inputs.x }}");
    expect(withWorktree("cd {{ worktree }}", { workspaceDir: "/ws", worktree: null })).toBe("cd /ws");
  });
});

describe("removedGitlinks (real git)", () => {
  it("names submodule entries the index deletes relative to the base, committed or staged; ignores plain files", async () => {
    const dir = await tmp("gitlink");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "a@b.c");
    await git(dir, "config", "user.name", "t");
    await writeFile(path.join(dir, "keep.txt"), "x");
    await git(dir, "add", "keep.txt");
    await git(dir, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,ops/sub");
    await git(dir, "commit", "-qm", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    expect(await removedGitlinks(dir, base)).toEqual([]);
    await git(dir, "rm", "-q", "--cached", "keep.txt");
    expect(await removedGitlinks(dir, base)).toEqual([]);
    await git(dir, "rm", "-q", "--cached", "ops/sub");
    expect(await removedGitlinks(dir, base)).toEqual(["ops/sub"]);
    await git(dir, "commit", "-qm", "delete");
    expect(await removedGitlinks(dir, base)).toEqual(["ops/sub"]);
    expect(await removedGitlinks(dir, "deadbeef")).toEqual([]);
  });
});

describe("worktree create and remove (real git)", () => {
  const iso = { mode: "worktree" as const, submodules: "none" as const, base: null };

  it("branches off a fresh origin/main, not the stale local main", async () => {
    const ws = await workspace();
    const other = path.join(ws.base, "other");
    await git(ws.base, "clone", "-q", ws.origin, other);
    await writeFile(path.join(other, "new.txt"), "x");
    await git(other, "add", "-A");
    await git(other, "commit", "-qm", "newer");
    await git(other, "push", "-q", "origin", "main");
    const created = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: iso });
    expect(created.path).toBe(path.join(ws.worktrees, "run_a"));
    expect(created.base).toBe("origin/main");
    expect(created.baseSha).toBe(await git(other, "rev-parse", "HEAD"));
    expect(existsSync(path.join(created.path, "new.txt"))).toBe(true);
    expect(await git(created.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("playbooks/p-a");
    expect(created.workspaceSnapshot).toContain(await git(ws.dir, "rev-parse", "HEAD"));
  });

  it("removes the directory, the git metadata and the branch", async () => {
    const ws = await workspace();
    const created = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: iso });
    const result = await removeWorktree({ repo: ws.dir, dir: created.path, worktreesDir: ws.worktrees, branch: created.branch, linked: [], force: false, baseSha: created.baseSha });
    expect(result.keptBranch).toBeNull();
    expect(existsSync(created.path)).toBe(false);
    expect(await git(ws.dir, "worktree", "list")).not.toContain("run_a");
    expect(await git(ws.dir, "branch", "--list", "playbooks/p-a")).toBe("");
  });

  it("keeps the branch when it holds commits that exist nowhere else, and deletes it once pushed", async () => {
    const ws = await workspace();
    const created = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: iso });
    await writeFile(path.join(created.path, "work.txt"), "w");
    await git(created.path, "add", "-A");
    await git(created.path, "commit", "-qm", "work");
    expect(await hasUnpushedCommits(ws.dir, created.branch, created.baseSha)).toBe(true);
    const kept = await removeWorktree({ repo: ws.dir, dir: created.path, worktreesDir: ws.worktrees, branch: created.branch, linked: [], force: false, baseSha: created.baseSha });
    expect(kept.keptBranch).toBe("playbooks/p-a");
    expect(await git(ws.dir, "branch", "--list", "playbooks/p-a")).toContain("playbooks/p-a");

    const again = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_b", branch: "playbooks/p-b", isolation: iso });
    await writeFile(path.join(again.path, "w2.txt"), "w");
    await git(again.path, "add", "-A");
    await git(again.path, "commit", "-qm", "work2");
    await git(again.path, "push", "-q", "origin", "playbooks/p-b");
    expect(await hasUnpushedCommits(ws.dir, again.branch, again.baseSha)).toBe(false);
  });

  it("survives a directory it cannot read, and never deletes outside the worktrees directory", async () => {
    const ws = await workspace();
    const created = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: iso });
    await mkdir(path.join(created.path, "locked", "inner"), { recursive: true });
    await writeFile(path.join(created.path, "locked", "inner", "f"), "x");
    await chmod(path.join(created.path, "locked"), 0o000);
    await removeWorktree({ repo: ws.dir, dir: created.path, worktreesDir: ws.worktrees, branch: created.branch, linked: [], force: true, baseSha: created.baseSha });
    expect(existsSync(created.path)).toBe(false);

    const outside = await tmp("outside");
    await writeFile(path.join(outside, "keep.txt"), "mine");
    await expect(removeWorktree({ repo: ws.dir, dir: outside, worktreesDir: ws.worktrees, branch: null, linked: [], force: true })).rejects.toThrow(/not inside/);
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });

  it("creates nothing when the worktree cannot be made", async () => {
    const ws = await workspace();
    await expect(createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: { ...iso, submodules: ["nope"] } })).rejects.toThrow(/not a submodule/);
    expect(existsSync(path.join(ws.worktrees, "run_a"))).toBe(false);
    expect(await git(ws.dir, "branch", "--list", "playbooks/p-a")).toBe("");
  });

  describe("submodules", () => {
    async function withSub() {
      const subOrigin = await tmp("sub-origin");
      await git(subOrigin, "init", "-q");
      await writeFile(path.join(subOrigin, "lib.txt"), "lib");
      await git(subOrigin, "add", "-A");
      await git(subOrigin, "commit", "-qm", "lib");
      await git(subOrigin, "branch", "-M", "main");
      return workspace({}, async (dir) => {
        await git(dir, "submodule", "add", "-q", subOrigin, "ops/lib");
      });
    }

    it("none leaves them empty for the agents to init; a list links them to the workspace's own clone", async () => {
      const ws = await withSub();
      const bare = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: iso });
      expect(bare.linked).toEqual([]);
      expect(existsSync(path.join(bare.path, "ops/lib/lib.txt"))).toBe(false);

      const linked = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_b", branch: "playbooks/p-b", isolation: { ...iso, submodules: ["ops/lib"] } });
      expect(linked.linked).toEqual(["ops/lib"]);
      expect(await readFile(path.join(linked.path, "ops/lib/lib.txt"), "utf8")).toBe("lib");
      expect(await git(path.join(ws.dir, "ops/lib"), "worktree", "list")).toContain("run_b");

      const all = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_c", branch: "playbooks/p-c", isolation: { ...iso, submodules: "all" } });
      expect(all.linked).toEqual(["ops/lib"]);

      for (const [created, id] of [[linked, "run_b"], [all, "run_c"], [bare, "run_a"]] as const) {
        await removeWorktree({ repo: ws.dir, dir: created.path, worktreesDir: ws.worktrees, branch: created.branch, linked: created.linked, force: false, baseSha: created.baseSha });
        expect(existsSync(created.path), id).toBe(false);
      }
      expect(await git(path.join(ws.dir, "ops/lib"), "worktree", "list")).not.toContain("run_");
      expect(await git(ws.dir, "worktree", "list")).not.toContain("run_");
    });

    it("removes a worktree whose submodule was initialised in place (git alone refuses)", async () => {
      const ws = await withSub();
      const created = await createWorktree({ workspaceDir: ws.dir, worktreesDir: ws.worktrees, runId: "run_a", branch: "playbooks/p-a", isolation: iso });
      await git(created.path, "submodule", "update", "--init", "--", "ops/lib");
      expect(existsSync(path.join(created.path, "ops/lib/lib.txt"))).toBe(true);
      await removeWorktree({ repo: ws.dir, dir: created.path, worktreesDir: ws.worktrees, branch: created.branch, linked: [], force: false, baseSha: created.baseSha });
      expect(existsSync(created.path)).toBe(false);
      expect(await git(ws.dir, "worktree", "list")).not.toContain("run_a");
    });
  });
});

// ---------------------------------------------------------------------------------- runtime

const ISO_PLAYBOOK = `
title: Iso
isolation: worktree
steps:
  - id: work
    role: { name: implementer, prompt: "Work in {{ worktree }}." }
`;
const PLAIN_PLAYBOOK = `
title: Plain
steps:
  - id: work
    role: { name: implementer }
`;
const FAILKEEP_PLAYBOOK = `
title: Iso
isolation: worktree
steps:
  - id: work
    role: { name: implementer }
`;

async function runtimeSetup(opts: { gitlink?: boolean; extraFiles?: Record<string, string> } = {}) {
  const files: Record<string, string> = { ...opts.extraFiles, ".gitignore": "node_modules\n", ".paseo/plugins/playbooks/iso.yaml": ISO_PLAYBOOK, ".paseo/plugins/playbooks/plain.yaml": PLAIN_PLAYBOOK, ".paseo/plugins/playbooks/iso2.yaml": FAILKEEP_PLAYBOOK };
  const ws = await workspace(files);
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(ws.dir, ".paseo/plugins/playbooks/roles"), { recursive: true });
  await git(ws.dir, "add", "-A");
  if (opts.gitlink) await git(ws.dir, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,ops/sub");
  await git(ws.dir, "commit", "-qm", "roles");
  await git(ws.dir, "push", "-q", "origin", "main");
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ id: string; labels: Record<string, string>; systemPrompt: string }> = [];
  const running = new Set<string>();
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
    archive: async () => undefined,
  });
  const create = async (input: { labels: Record<string, string>; config: { systemPrompt: string } }) => {
    const id = `agent${++agents}`;
    created.push({ id, labels: input.labels, systemPrompt: input.config.systemPrompt });
    return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
  };
  const paseo = {
    agents: {
      ref,
      list: async () => ({ entries: created.map((agent) => ({ agent: { id: agent.id, labels: agent.labels, archivedAt: null, internal: false, status: running.has(agent.id) ? "running" : "idle" } })) }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: ws.dir }), agents: { create }, archive: async () => undefined }) },
  };
  const store = new RunStore(path.join(ws.base, "data", "runs"));
  await store.init();
  const runtime = new Runtime(store, { pollMs: 3_600_000 });
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  return { ...ws, store, runtime, sent, created, running };
}

const mgr = (id: string, cwd: string) => ({ id, workspaceId: "ws", cwd });

describe("isolated runs", () => {
  it("creates the worktree at start, records it, and tells every agent to work only there", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    expect(run.worktree).toMatchObject({ path: path.join(ctx.worktrees, run.id), state: "active", base: "origin/main", linked: [] });
    expect(run.branch).toBe(`playbooks/iso-${run.id.replace(/^run_/, "")}`);
    expect(await git(run.worktree!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run.branch);
    expect(run.worktree!.workspaceSnapshot).toContain(await git(ctx.dir, "rev-parse", "HEAD"));

    const { agentId } = await ctx.runtime.startStep("m1", run.id, "work", "a brief");
    const system = ctx.created.find((agent) => agent.id === agentId)!.systemPrompt;
    const prompt = ctx.sent.find((entry) => entry.agentId === agentId)!.text;
    for (const text of [system, prompt]) {
      expect(text).toContain("ISOLATED RUN");
      expect(text).toContain(run.worktree!.path);
      expect(text).toMatch(/never edit/i);
    }
    expect(prompt).toContain(`Work in ${run.worktree!.path}.`);
    expect(prompt).toContain("a brief");
  });

  it("lets several isolated runs share a workspace, but keeps one run per workspace without isolation", async () => {
    const ctx = await runtimeSetup();
    const a = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    const b = await ctx.runtime.startPlaybook(mgr("m2", ctx.dir), "iso", {});
    expect(a.worktree!.path).not.toBe(b.worktree!.path);
    expect(a.branch).not.toBe(b.branch);
    // A run without isolation edits the checkout the isolated runs guard: it waits.
    await expect(ctx.runtime.startPlaybook(mgr("m3", ctx.dir), "plain", {})).rejects.toThrow(/active isolated run/);
    await ctx.runtime.cancelRun(a.id, "x", null);
    await ctx.runtime.cancelRun(b.id, "x", null);
    const plain = await ctx.runtime.startPlaybook(mgr("m3", ctx.dir), "plain", {});
    expect(plain.worktree).toBeNull();
    await expect(ctx.runtime.startPlaybook(mgr("m4", ctx.dir), "plain", {})).rejects.toThrow(/one active run per workspace/);
    await expect(ctx.runtime.startPlaybook(mgr("m5", ctx.dir), "iso", {})).rejects.toThrow(/without isolation/);
  });

  it("fails the step, naming the paths, when an agent edited the original workspace instead", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    const { agentId } = await ctx.runtime.startStep("m1", run.id, "work", "");
    await writeFile(path.join(ctx.dir, "stray.txt"), "wrong tree");
    await ctx.runtime.report(agentId, { outcome: "success", summary: "done", outputs: {} });
    await ctx.runtime.onTurnEnded(agentId, "completed");
    const after = ctx.store.get(run.id)!;
    const attempt = after.steps.work!.attempts[0]!;
    expect(attempt.report!.outcome).toBe("failure");
    expect(attempt.report!.summary).toMatch(/isolation guard.*stray\.txt/);
    expect(after.history.some((event) => event.type === "isolation_violation" && event.detail.includes("stray.txt"))).toBe(true);
    expect(ctx.sent.filter((entry) => entry.agentId === "m1").map((entry) => entry.text).join("\n")).toMatch(/Isolation guard failed.*stray\.txt/);
  });

  it("fails the step, naming the path, when its branch deletes a submodule entry; isolation.allow_gitlink_removal turns the guard off", async () => {
    const ctx = await runtimeSetup({ gitlink: true, extraFiles: { ".paseo/plugins/playbooks/iso-ok.yaml": ISO_PLAYBOOK.replace("isolation: worktree", "isolation: { mode: worktree, allow_gitlink_removal: true }") } });
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    const { agentId } = await ctx.runtime.startStep("m1", run.id, "work", "");
    await git(run.worktree!.path, "rm", "-q", "--cached", "ops/sub");
    await git(run.worktree!.path, "commit", "-qm", "oops");
    await ctx.runtime.report(agentId, { outcome: "success", summary: "done", outputs: {} });
    await ctx.runtime.onTurnEnded(agentId, "completed");
    const after = ctx.store.get(run.id)!;
    expect(after.steps.work!.attempts[0]!.report!.outcome).toBe("failure");
    expect(after.steps.work!.attempts[0]!.report!.summary).toMatch(/gitlink guard.*ops\/sub/);
    expect(after.history.some((event) => event.type === "gitlink_violation" && event.detail.includes("ops/sub"))).toBe(true);
    expect(ctx.sent.filter((entry) => entry.agentId === "m1").map((entry) => entry.text).join("\n")).toMatch(/Gitlink guard failed.*ops\/sub/);

    await ctx.runtime.cancelRun(run.id, "x", null);
    const ok = await ctx.runtime.startPlaybook(mgr("m2", ctx.dir), "iso-ok", {});
    const started = await ctx.runtime.startStep("m2", ok.id, "work", "");
    await git(ok.worktree!.path, "rm", "-q", "--cached", "ops/sub");
    await git(ok.worktree!.path, "commit", "-qm", "intended");
    await ctx.runtime.report(started.agentId, { outcome: "success", summary: "done", outputs: {} });
    await ctx.runtime.onTurnEnded(started.agentId, "completed");
    expect(ctx.store.get(ok.id)!.steps.work!.attempts[0]!.report!.outcome).toBe("success");
  });

  it("passes a step that left the workspace alone and edited the worktree", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    const { agentId } = await ctx.runtime.startStep("m1", run.id, "work", "");
    await writeFile(path.join(run.worktree!.path, "feature.txt"), "right tree");
    await ctx.runtime.report(agentId, { outcome: "success", summary: "done", outputs: {} });
    await ctx.runtime.onTurnEnded(agentId, "completed");
    expect(ctx.store.get(run.id)!.steps.work!.attempts[0]!.report!.outcome).toBe("success");
  });

  it("deletes the worktree and its branch when the run ends, and says so in the history", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    await ctx.runtime.cancelRun(run.id, "stop", null);
    await ctx.runtime.onTurnEnded("m1", "completed");
    const ended = ctx.store.get(run.id)!;
    expect(ended.worktree!.state).toBe("removed");
    expect(existsSync(run.worktree!.path)).toBe(false);
    expect(await git(ctx.dir, "branch", "--list", run.branch!)).toBe("");
    expect(ended.history.some((event) => event.type === "worktree_removed")).toBe(true);
  });

  it("removes the worktree of a canceled run (an intentional end) unless it is dirty; only failure is kept by keep_failed", async () => {
    const ctx = await runtimeSetup();
    const canceled = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    expect(canceled.playbook.workspace.keepFailed).toBe(true);
    await ctx.runtime.cancelRun(canceled.id, "stop", null);
    await ctx.runtime.onTurnEnded("m1", "completed");
    expect(ctx.store.get(canceled.id)!.status).toBe("canceled");
    expect(ctx.store.get(canceled.id)!.worktree!.state).toBe("removed");
    expect(existsSync(canceled.worktree!.path)).toBe(false);
  });

  it("waits while an agent of the run is still running", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    const { agentId } = await ctx.runtime.startStep("m1", run.id, "work", "");
    ctx.running.add(agentId);
    await ctx.runtime.cancelRun(run.id, "stop", null);
    await ctx.runtime.onTurnEnded("m1", "completed");
    expect(existsSync(run.worktree!.path)).toBe(true);
    ctx.running.delete(agentId);
    await ctx.runtime.onTurnEnded("m1", "completed");
    expect(existsSync(run.worktree!.path)).toBe(false);
  });

  it("keeps the worktree of a failed run while workspace.keep_failed is true, and one with uncommitted changes", async () => {
    const ctx = await runtimeSetup();
    const failed = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    await (ctx.runtime as unknown as { failRun(id: string, reason: string): Promise<void> }).failRun(failed.id, "boom");
    await ctx.runtime.onTurnEnded("m1", "completed");
    expect(ctx.store.get(failed.id)!.worktree!.state).toBe("kept");
    expect(existsSync(failed.worktree!.path)).toBe(true);
    expect(ctx.store.get(failed.id)!.history.find((event) => event.type === "worktree_kept")!.detail).toMatch(/keep_failed/);

    const dirty = await ctx.runtime.startPlaybook(mgr("m2", ctx.dir), "iso2", {});
    await writeFile(path.join(dirty.worktree!.path, "unsaved.txt"), "wip");
    await ctx.runtime.cancelRun(dirty.id, "stop", null);
    await ctx.runtime.onTurnEnded("m2", "completed");
    expect(ctx.store.get(dirty.id)!.worktree!.state).toBe("kept");
    expect(ctx.store.get(dirty.id)!.history.find((event) => event.type === "worktree_kept")!.detail).toMatch(/unsaved\.txt/);
    expect(existsSync(dirty.worktree!.path)).toBe(true);
  });

  it("keeps the worktree and warns the manager when the workspace changed and the run ends", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    await writeFile(path.join(ctx.dir, "oops.txt"), "x");
    await ctx.runtime.cancelRun(run.id, "stop", null);
    await ctx.runtime.onTurnEnded("m1", "completed");
    const ended = ctx.store.get(run.id)!;
    expect(ended.worktree!.state).toBe("kept");
    expect(ended.history.some((event) => event.type === "isolation_violation" && event.detail.includes("oops.txt"))).toBe(true);
  });

  it("brings the worktree back when an ended run is restarted", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    await ctx.runtime.cancelRun(run.id, "stop", null);
    await ctx.runtime.onTurnEnded("m1", "completed");
    expect(existsSync(run.worktree!.path)).toBe(false);
    const { run: restarted } = await ctx.runtime.restartRun(run.id, "work", null, "t");
    expect(restarted.worktree!.state).toBe("active");
    expect(existsSync(restarted.worktree!.path)).toBe(true);
    expect(await git(restarted.worktree!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run.branch);
  });

  it("sweeps orphans at startup: directories of runs that no longer exist, with their git metadata", async () => {
    const ctx = await runtimeSetup();
    const live = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    const ghost = await createWorktree({ workspaceDir: ctx.dir, worktreesDir: ctx.worktrees, runId: "run_ghost", branch: "playbooks/iso-ghost", isolation: { mode: "worktree", submodules: "none", base: null } });
    await writeFile(path.join(ghost.path, "wip.txt"), "unsaved");
    await mkdir(path.join(ctx.worktrees, "run_plain_dir"), { recursive: true });
    const removed = await ctx.runtime.sweepWorktrees();
    expect(removed.map((dir) => path.basename(dir)).sort()).toEqual(["run_ghost", "run_plain_dir"]);
    expect(existsSync(ghost.path)).toBe(false);
    expect(await git(ctx.dir, "worktree", "list")).not.toContain("run_ghost");
    expect(await git(ctx.dir, "branch", "--list", "playbooks/iso-ghost")).toBe("");
    expect(existsSync(live.worktree!.path)).toBe(true);
    expect((await stat(ctx.worktrees)).isDirectory()).toBe(true);
  });

  it("removes the worktree of a run deleted with its workspace", async () => {
    const ctx = await runtimeSetup();
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    await ctx.runtime.onWorkspaceArchived("ws");
    expect(ctx.store.get(run.id)).toBeUndefined();
    expect(existsSync(run.worktree!.path)).toBe(false);
  });
});

describe("playbooks from fresh main", () => {
  /** Pushes a change to the playbook files to origin/main from another clone; the workspace checkout stays behind. */
  async function pushToOrigin(ctx: Awaited<ReturnType<typeof runtimeSetup>>, files: Record<string, string>) {
    const other = path.join(ctx.base, "other");
    if (existsSync(other)) await git(other, "pull", "-q", "origin", "main");
    else await git(ctx.base, "clone", "-q", ctx.origin, other);
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(other, name), body);
    await git(other, "add", "--", ...Object.keys(files));
    await git(other, "commit", "-qm", "new rules");
    await git(other, "push", "-q", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  }
  const NEWER = ISO_PLAYBOOK.replace("title: Iso", "title: Iso v2").replace("Work in", "New rule, work in");
  const PATH = ".paseo/plugins/playbooks/iso.yaml";

  it("starts an isolated run on origin's playbook without touching the workspace checkout", async () => {
    const ctx = await runtimeSetup();
    const head = await git(ctx.dir, "rev-parse", "HEAD");
    const sha = await pushToOrigin(ctx, { [PATH]: NEWER });
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    expect(run.playbook.title).toBe("Iso v2");
    expect(run.definition).toEqual({ source: "origin", ref: "origin/main", sha, note: null });
    expect(run.worktree!.baseSha).toBe(sha);
    expect(await git(ctx.dir, "rev-parse", "HEAD")).toBe(head);
    expect(definitionNote(run)).toContain("not from the workspace checkout");
    const { agentId } = await ctx.runtime.startStep("m1", run.id, "work", "");
    expect(ctx.sent.find((entry) => entry.agentId === agentId)!.text).toContain("New rule, work in");
  });

  it("falls back to the workspace checkout, and says so, when the fetch fails", async () => {
    const ctx = await runtimeSetup();
    await pushToOrigin(ctx, { [PATH]: NEWER });
    await git(ctx.dir, "remote", "set-url", "origin", path.join(ctx.base, "gone.git"));
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    expect(run.playbook.title).toBe("Iso");
    expect(run.definition).toMatchObject({ source: "workspace", sha: null });
    expect(run.definition!.note).toMatch(/could not fetch origin\/main/);
    expect(definitionNote(run)).toMatch(/WARNING.*workspace checkout/);
  });

  it("falls back when the playbook is invalid on origin or no longer isolated", async () => {
    const ctx = await runtimeSetup();
    await pushToOrigin(ctx, { [PATH]: "title: Iso\nisolation: worktree\nsteps: nope\n" });
    const broken = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "iso", {});
    expect(broken.playbook.title).toBe("Iso");
    expect(broken.definition!.note).toMatch(/invalid on origin\/main/);
    await ctx.runtime.cancelRun(broken.id, "x", null);
    await pushToOrigin(ctx, { [PATH]: PLAIN_PLAYBOOK });
    const plain = await ctx.runtime.startPlaybook(mgr("m2", ctx.dir), "iso", {});
    expect(plain.definition!.note).toMatch(/no longer an isolated/);
  });

  it("leaves runs without isolation on the workspace checkout", async () => {
    const ctx = await runtimeSetup();
    await pushToOrigin(ctx, { ".paseo/plugins/playbooks/plain.yaml": PLAIN_PLAYBOOK.replace("Plain", "Plain v2") });
    const run = await ctx.runtime.startPlaybook(mgr("m1", ctx.dir), "plain", {});
    expect(run.playbook.title).toBe("Plain");
    expect(run.definition).toBeNull();
  });

  it("validates what a new run would load: origin's copy for isolated playbooks, the checkout's for the rest", async () => {
    const ctx = await runtimeSetup();
    await pushToOrigin(ctx, { [PATH]: NEWER, ".paseo/plugins/playbooks/plain.yaml": PLAIN_PLAYBOOK.replace("Plain", "Plain v2") });
    const resolved = await resolveForNewRun(ctx.dir, await loadPlaybooks(ctx.dir));
    const by = (id: string) => resolved.find((item) => item.entry.id === id)!;
    expect(by("iso")).toMatchObject({ source: "origin", ref: "origin/main" });
    expect(by("iso").entry.playbook!.title).toBe("Iso v2");
    expect(by("plain")).toMatchObject({ source: "workspace" });
    expect(by("plain").entry.playbook!.title).toBe("Plain");

    await git(ctx.dir, "remote", "set-url", "origin", path.join(ctx.base, "gone.git"));
    const offline = await resolveForNewRun(ctx.dir, await loadPlaybooks(ctx.dir));
    expect(offline.find((item) => item.entry.id === "iso")).toMatchObject({ source: "workspace", note: expect.stringMatching(/could not fetch/) });
  });
});
