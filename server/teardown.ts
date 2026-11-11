import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** How long one teardown command may run before it is killed. */
export const TEARDOWN_TIMEOUT_MS = 10 * 60 * 1000;

export interface TeardownFailure {
  command: string;
  reason: string;
}

export interface TeardownResult {
  /** Commands that finished with exit code 0. */
  ran: string[];
  /** Commands that failed, timed out or could not start. */
  failed: TeardownFailure[];
}

/**
 * The shell commands of `worktree.teardown` in the `paseo.json` at the root of `dir`, read the way
 * Paseo reads them: one string, or a list of strings. Missing or unreadable config means none.
 */
export async function readTeardownCommands(dir: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(dir, "paseo.json"), "utf8"));
  } catch {
    return [];
  }
  const teardown = (parsed as { worktree?: { teardown?: unknown } } | null)?.worktree?.teardown;
  if (typeof teardown === "string") return teardown.trim() ? [teardown] : [];
  if (Array.isArray(teardown)) return teardown.filter((command): command is string => typeof command === "string" && command.trim() !== "");
  return [];
}

/**
 * Runs a worktree's teardown commands in the worktree, before the plugin removes it, so whatever
 * the repository started there (a local stack, for one) is stopped too. Best effort: a failing
 * command is reported, never thrown, so the removal still goes ahead.
 */
export async function runWorktreeTeardown(input: { dir: string; repo: string; timeoutMs?: number }): Promise<TeardownResult> {
  const result: TeardownResult = { ran: [], failed: [] };
  if (!existsSync(input.dir)) return result;
  for (const command of await readTeardownCommands(input.dir)) {
    const failure = await runOne(command, input.dir, input.repo, input.timeoutMs ?? TEARDOWN_TIMEOUT_MS);
    if (failure) result.failed.push({ command, reason: failure });
    else result.ran.push(command);
  }
  return result;
}

/** Runs one command with `sh -c` in `dir`; resolves to the failure reason, or null on success. */
function runOne(command: string, dir: string, repo: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (reason: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    const child = spawn("sh", ["-c", command], {
      cwd: dir,
      env: { ...process.env, PASEO_WORKTREE_PATH: dir, PASEO_SOURCE_CHECKOUT_PATH: repo },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    child.on("error", (error) => finish(error.message));
    child.on("close", (code) => {
      if (code === 0) finish(null);
      else finish(`exit ${code}${output.trim() ? `: ${output.trim()}` : ""}`);
    });
  });
}
