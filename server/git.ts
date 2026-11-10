import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Submodule entries (mode 160000) that the index of `cwd` deletes relative to `baseSha`: committed on the
 * branch or staged. Empty when `baseSha` cannot be read.
 */
export async function removedGitlinks(cwd: string, baseSha: string): Promise<string[]> {
  try {
    const out = await git(cwd, ["-c", "core.quotepath=off", "diff", "--cached", "--raw", "--no-renames", baseSha]);
    return out
      .split("\n")
      .map((line) => /^:160000 000000 \S+ \S+ D\t(.+)$/.exec(line)?.[1])
      .filter((path): path is string => Boolean(path));
  } catch {
    return [];
  }
}

/** HEAD plus `git status --porcelain` (ignored files excluded). Null outside a git checkout. */
export async function checkoutSnapshot(cwd: string): Promise<string | null> {
  try {
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return `${head}\n${status}`;
  } catch {
    return null;
  }
}

/** Describes what changed between two snapshots, or null when identical. */
export function snapshotDiff(before: string, after: string | null): string | null {
  if (after === null) return "the checkout could not be read";
  if (before === after) return null;
  const [headBefore, ...statusBefore] = before.split("\n");
  const [headAfter, ...statusAfter] = after.split("\n");
  const parts: string[] = [];
  if (headBefore !== headAfter) parts.push(`HEAD moved from ${headBefore?.slice(0, 8)} to ${headAfter?.slice(0, 8)}`);
  const added = statusAfter.filter((line) => line && !statusBefore.includes(line));
  if (added.length > 0) parts.push(`changed files: ${added.slice(0, 10).map((line) => line.slice(3)).join(", ")}${added.length > 10 ? ", …" : ""}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Current branch name, or the commit when detached. */
export async function currentRef(cwd: string): Promise<string | null> {
  try {
    const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch && branch !== "HEAD") return branch;
    return (await git(cwd, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

/** The project's default branch: origin's HEAD, else `main` or `master` if present, else the current branch. */
export async function defaultBranch(cwd: string): Promise<string | null> {
  try {
    const head = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (head) return head.replace(/^origin\//, "");
  } catch {
    // No origin HEAD: look for the usual names.
  }
  for (const name of ["main", "master"]) {
    try {
      await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      return name;
    } catch {
      // Not this one.
    }
  }
  return currentRef(cwd);
}

/**
 * The ref to branch a new worktree off for `branch`: `origin/<branch>`, fetched first, when
 * origin has it (a local branch of the same name may be far behind); else `branch` itself.
 */
export async function freshRef(cwd: string, branch: string): Promise<string> {
  try {
    await git(cwd, ["fetch", "--quiet", "origin", branch]);
  } catch {
    // Offline or no origin: whatever the remote-tracking ref already holds, if any.
  }
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return `origin/${branch}`;
  } catch {
    return branch;
  }
}

/** Best effort: fetches `branch` from origin and fast-forwards the checkout to it. Never fails. */
export async function fastForward(cwd: string, branch: string): Promise<void> {
  try {
    await git(cwd, ["fetch", "--quiet", "origin", branch]);
    await git(cwd, ["merge", "--ff-only", "--quiet", `origin/${branch}`]);
  } catch {
    // Offline, no origin, or not a fast-forward: keep the checkout as it is.
  }
}
