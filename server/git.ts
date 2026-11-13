import { execFile, spawn } from "node:child_process";
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

/**
 * Like `snapshotDiff`, for the original workspace checkout of an isolated run: a HEAD that only
 * fast-forwarded (the baseline commit is an ancestor of the current one) is not a violation, as the
 * checkout is synced to origin outside the run. A rewind, a switch to another line of history or any
 * change to the working tree still is.
 */
export async function checkoutViolationSince(cwd: string, baseline: string): Promise<string | null> {
  const after = await checkoutSnapshot(cwd);
  const detail = snapshotDiff(baseline, after);
  if (detail === null || after === null) return detail;
  const headBefore = baseline.split("\n")[0] ?? "";
  const headAfter = after.split("\n")[0] ?? "";
  if (headBefore !== headAfter && (await isAncestor(cwd, headBefore, headAfter))) {
    // Same working tree state, HEAD only moved forward.
    const statusBefore = baseline.split("\n").slice(1).join("\n");
    const statusAfter = after.split("\n").slice(1).join("\n");
    return snapshotDiff(`x\n${statusBefore}`, `x\n${statusAfter}`);
  }
  return detail;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
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
  return (await freshRefInfo(cwd, branch)).ref;
}

/** Like `freshRef`, and says whether the fetch failed (offline, no origin): `fetchError` is its message. */
export async function freshRefInfo(cwd: string, branch: string): Promise<{ ref: string; fetchError: string | null }> {
  let fetchError: string | null = null;
  try {
    await git(cwd, ["fetch", "--quiet", "origin", branch]);
  } catch (error) {
    // Offline or no origin: whatever the remote-tracking ref already holds, if any.
    fetchError = (error instanceof Error ? error.message : String(error)).split("\n").find((line) => line.trim() && !line.startsWith("Command failed"))?.trim() ?? "git fetch failed";
  }
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return { ref: `origin/${branch}`, fetchError };
  } catch {
    return { ref: branch, fetchError };
  }
}

/**
 * Copies `paths` of `ref` (a commit-ish of `cwd`'s repository) into `dest`, without a checkout.
 * Paths the ref does not have are skipped.
 */
export async function exportPaths(cwd: string, ref: string, paths: readonly string[], dest: string): Promise<void> {
  const present: string[] = [];
  for (const rel of paths) {
    if ((await git(cwd, ["ls-tree", "--name-only", ref, "--", rel]).catch(() => "")).trim()) present.push(rel);
  }
  if (present.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const archive = spawn("git", ["-C", cwd, "archive", "--format=tar", ref, "--", ...present], { stdio: ["ignore", "pipe", "pipe"] });
    const untar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(untar.stdin);
    let failure = "";
    archive.stderr.on("data", (chunk) => (failure += String(chunk)));
    untar.stderr.on("data", (chunk) => (failure += String(chunk)));
    archive.on("error", reject);
    untar.on("error", reject);
    untar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(failure.trim() || `tar exited with ${code}`))));
  });
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
