import { lstat } from "node:fs/promises";

/** Failures of a repeated job, per key: when the next try may start, and when to give up. */
export class Backoff {
  private readonly failures = new Map<string, { count: number; nextAt: number }>();

  /** `delaysMs[i]` is the wait after the (i+1)th failure; the failure after the last one gives up. */
  constructor(private readonly delaysMs: readonly number[]) {}

  /** Whether a try may start now (no failure recorded, or its wait is over). */
  ready(key: string, now = Date.now()): boolean {
    const failure = this.failures.get(key);
    return !failure || now >= failure.nextAt;
  }

  /** Records a failure. Returns the wait before the next try, or null once the cap is reached (the record is dropped). */
  fail(key: string, now = Date.now()): { attempt: number; waitMs: number | null } {
    const attempt = (this.failures.get(key)?.count ?? 0) + 1;
    const waitMs = this.delaysMs[attempt - 1] ?? null;
    if (waitMs === null) this.failures.delete(key);
    else this.failures.set(key, { count: attempt, nextAt: now + waitMs });
    return { attempt, waitMs };
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

/**
 * The error text, plus who owns the path a permission error names when that is not the user the
 * plugin runs as (a directory a container or `sudo` created inside a worktree): the plugin cannot
 * delete it, and the message says so.
 */
export async function describeRemovalError(error: unknown): Promise<string> {
  const text = error instanceof Error ? error.message : String(error);
  const { code, path: target } = (error ?? {}) as { code?: string; path?: string };
  if ((code !== "EACCES" && code !== "EPERM") || !target || typeof process.getuid !== "function") return text;
  try {
    const owner = (await lstat(target)).uid;
    if (owner !== process.getuid()) return `${text} (owned by uid ${owner}, the plugin runs as uid ${process.getuid()}: remove it with that user's privileges)`;
  } catch {
    /* gone or unreadable: the plain text */
  }
  return text;
}
