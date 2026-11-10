import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Isolation } from "../shared/types";
import { checkoutSnapshot, defaultBranch, freshRef } from "./git";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The branch an isolated run's worktree gets: `playbooks/<playbook>-<id>`, like a run's own workspace. */
export function worktreeBranch(playbookId: string, id: string): string {
  return `playbooks/${playbookId}-${id}`;
}

/** The run id a worktree directory belongs to: directories are named by run id. */
export function worktreePath(worktreesDir: string, runId: string): string {
  return path.join(worktreesDir, runId);
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  base: string;
  baseSha: string;
  linked: string[];
  workspaceSnapshot: string | null;
}

/** Submodule paths declared by `.gitmodules` of a checkout. */
async function submodulePaths(dir: string): Promise<string[]> {
  try {
    const out = await git(dir, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
    return out.split("\n").filter(Boolean).map((line) => line.slice(line.indexOf(" ") + 1).trim());
  } catch {
    return [];
  }
}

/**
 * Creates the run's worktree under `worktreesDir/<runId>`: a new branch off a fresh `origin/<base>`
 * of the workspace's repository. Submodules named by `isolation.submodules` are linked: each as a
 * detached worktree of the workspace's own clone of it when the workspace has one (fast, shares
 * objects), else initialised in place. Anything else is left for the agents to init lazily.
 * On failure nothing is left behind.
 */
export async function createWorktree(input: { workspaceDir: string; worktreesDir: string; runId: string; branch: string; isolation: Omit<Isolation, "allowGitlinkRemoval">; reuseBranch?: boolean }): Promise<CreatedWorktree> {
  const dir = worktreePath(input.worktreesDir, input.runId);
  const workspaceSnapshot = await checkoutSnapshot(input.workspaceDir);
  const base = input.isolation.base ?? (await defaultBranch(input.workspaceDir));
  if (!base) throw new Error(`cannot create a worktree: no base branch in ${input.workspaceDir}`);
  const ref = await freshRef(input.workspaceDir, base);
  await mkdir(input.worktreesDir, { recursive: true });
  const linked: string[] = [];
  try {
    const existing = input.reuseBranch ? await existingBranch(input.workspaceDir, input.branch) : null;
    if (existing === "local") await git(input.workspaceDir, ["worktree", "add", "--quiet", dir, input.branch]);
    else if (existing === "origin") await git(input.workspaceDir, ["worktree", "add", "--quiet", "-b", input.branch, dir, `origin/${input.branch}`]);
    else await git(input.workspaceDir, ["worktree", "add", "--quiet", "-b", input.branch, dir, ref]);
    const baseSha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const declared = await submodulePaths(dir);
    const wanted = input.isolation.submodules === "none" ? [] : input.isolation.submodules === "all" ? declared : input.isolation.submodules;
    const unknown = wanted.filter((sub) => !declared.includes(sub));
    if (unknown.length > 0) throw new Error(`isolation.submodules: not a submodule of the repository: ${unknown.join(", ")}`);
    for (const sub of wanted) {
      const source = path.join(input.workspaceDir, sub);
      if (await exists(path.join(source, ".git"))) {
        // Pinned commit of the worktree's gitlink, else the sub-repo's own fresh default branch.
        const pinned = (await git(dir, ["rev-parse", `HEAD:${sub}`])).trim();
        const target = (await hasCommit(source, pinned)) ? pinned : await subRef(source);
        await git(source, ["worktree", "add", "--quiet", "--detach", path.join(dir, sub), target]);
      } else {
        await git(dir, ["submodule", "update", "--init", "--", sub]);
      }
      linked.push(sub);
    }
    return { path: dir, branch: input.branch, base: ref, baseSha, linked, workspaceSnapshot };
  } catch (error) {
    await removeWorktree({ repo: input.workspaceDir, dir, worktreesDir: input.worktreesDir, branch: input.branch, linked, force: true }).catch(() => undefined);
    throw error;
  }
}

/** A restarted run's branch, when it still exists: here, or on origin (the PR was pushed). */
async function existingBranch(repo: string, branch: string): Promise<"local" | "origin" | null> {
  const has = (ref: string) => git(repo, ["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false);
  if (await has(`refs/heads/${branch}`)) return "local";
  await git(repo, ["fetch", "--quiet", "origin", branch]).catch(() => undefined);
  return (await has(`refs/remotes/origin/${branch}`)) ? "origin" : null;
}

/** Submodule paths of a worktree that are linked worktrees of the repository's own submodule clones. */
export async function linkedSubmodules(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of await submodulePaths(dir)) {
    try {
      const text = await readFile(path.join(dir, sub, ".git"), "utf8");
      if (/gitdir:.*[\\/]worktrees[\\/]/.test(text)) out.push(sub);
    } catch {
      // Not initialised, or initialised in place: removed with the directory.
    }
  }
  return out;
}

async function subRef(source: string): Promise<string> {
  const branch = await defaultBranch(source);
  return branch ? await freshRef(source, branch) : "HEAD";
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** Paths with uncommitted changes in the worktree and in its linked submodules (ignored files excluded). */
export async function dirtyPaths(dir: string, linked: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const [prefix, cwd] of [["", dir] as const, ...linked.map((sub) => [`${sub}/`, path.join(dir, sub)] as const)]) {
    try {
      const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", ...(prefix === "" ? ["--ignore-submodules=all"] : [])]);
      out.push(...status.split("\n").filter(Boolean).map((line) => `${prefix}${line.slice(3)}`));
    } catch {
      // A checkout git cannot read has nothing to lose.
    }
  }
  return out;
}

/** Whether `branch` holds commits that exist nowhere else: not on any remote-tracking ref and past `baseSha`. */
export async function hasUnpushedCommits(repo: string, branch: string, baseSha: string): Promise<boolean> {
  try {
    const tip = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).trim();
    if (tip === baseSha) return false;
    const remotes = (await git(repo, ["branch", "-r", "--contains", tip])).trim();
    return remotes === "";
  } catch {
    return false;
  }
}

/** True when `dir` is inside `parent` (after resolving links), so a recursive delete may never leave it. */
async function inside(parent: string, dir: string): Promise<boolean> {
  try {
    const [p, d] = [await realpath(parent), await realpath(dir)];
    return d !== p && d.startsWith(p + path.sep);
  } catch {
    return false;
  }
}

/** Makes every directory of a tree writable again, so a tree with a `Permission denied` directory can be deleted. */
async function unlock(dir: string): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return;
      await chmod(current, info.mode | 0o700).catch(() => undefined);
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const name of entries) await walk(path.join(current, name));
  };
  await walk(dir);
}

export interface RemoveInput {
  /** A checkout of the repository the worktree belongs to (the workspace). */
  repo: string;
  dir: string;
  /** The plugin's worktrees directory: the only place a recursive delete may happen. */
  worktreesDir: string;
  branch: string | null;
  linked: string[];
  /** Also drop a worktree with uncommitted changes (an orphan nobody can claim). */
  force: boolean;
  baseSha?: string;
}

/**
 * Deletes a run's worktree and its metadata. Linked submodule worktrees are detached from their
 * clones first (`git worktree remove`), then the worktree itself; whatever git refuses, a guarded
 * delete finishes, never outside `worktreesDir`. The branch goes too, unless it holds commits that
 * exist nowhere else. Returns what was kept: the branch, when it was.
 */
export async function removeWorktree(input: RemoveInput): Promise<{ keptBranch: string | null; dropped: string[] }> {
  const { repo, dir, worktreesDir } = input;
  if (!(await inside(worktreesDir, dir)) && (await exists(dir))) throw new Error(`refusing to remove ${dir}: it is not inside ${worktreesDir}`);
  const dropped = input.force && (await exists(dir)) ? await dirtyPaths(dir, input.linked) : [];
  for (const sub of input.linked) {
    const source = path.join(repo, sub);
    await git(source, ["worktree", "remove", "--force", path.join(dir, sub)]).catch(() => undefined);
    await git(source, ["worktree", "prune"]).catch(() => undefined);
  }
  if (await exists(dir)) {
    await git(repo, ["worktree", "remove", "--force", "--force", dir]).catch(() => undefined);
  }
  if (await exists(dir)) {
    // git refused (a submodule checkout, a locked or unreadable directory): finish by hand, inside the plugin's directory only.
    await unlock(dir);
    await rm(dir, { recursive: true, force: true });
  }
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  let keptBranch: string | null = null;
  if (input.branch) {
    const unpushed = input.baseSha !== undefined && (await hasUnpushedCommits(repo, input.branch, input.baseSha));
    if (unpushed) keptBranch = input.branch;
    else await git(repo, ["branch", "-D", input.branch]).catch(() => undefined);
  }
  return { keptBranch, dropped };
}

/** The repository a leftover worktree directory belongs to, read from its `.git` file; null when unreadable. */
export async function repoOfWorktree(dir: string): Promise<{ repo: string; branch: string | null } | null> {
  try {
    const text = await readFile(path.join(dir, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!gitdir) return null;
    // <repo>/.git/worktrees/<name>  →  <repo>
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const at = gitdir.indexOf(marker);
    if (at < 0) return null;
    const repo = gitdir.slice(0, at);
    let branch: string | null = null;
    try {
      const head = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      branch = head && head !== "HEAD" ? head : null;
    } catch {
      // Branch unknown: it stays.
    }
    return (await exists(repo)) ? { repo, branch } : null;
  } catch {
    return null;
  }
}

/** Directory names under the worktrees directory (run ids), or none when it does not exist. */
export async function listWorktreeDirs(worktreesDir: string): Promise<string[]> {
  try {
    return await readdir(worktreesDir);
  } catch {
    return [];
  }
}

/** `git worktree prune` in a repository: forgets worktrees whose directory is gone. Never fails. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
}
