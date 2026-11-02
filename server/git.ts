import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
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
