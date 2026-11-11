import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTeardownCommands, runWorktreeTeardown } from "./teardown";

const temps: string[] = [];

async function worktreeWith(config: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "teardown-"));
  temps.push(dir);
  if (config !== undefined) await writeFile(path.join(dir, "paseo.json"), JSON.stringify(config));
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readTeardownCommands", () => {
  it("reads a single string and a list, as Paseo does", async () => {
    expect(await readTeardownCommands(await worktreeWith({ worktree: { teardown: "asdev stack down" } }))).toEqual(["asdev stack down"]);
    expect(await readTeardownCommands(await worktreeWith({ worktree: { teardown: ["a", "", "b"] } }))).toEqual(["a", "b"]);
  });

  it("finds nothing without a paseo.json, without the key, or with invalid JSON", async () => {
    expect(await readTeardownCommands(await worktreeWith(undefined))).toEqual([]);
    expect(await readTeardownCommands(await worktreeWith({ worktree: { setup: "make" } }))).toEqual([]);
    const dir = await worktreeWith(undefined);
    await writeFile(path.join(dir, "paseo.json"), "{ not json");
    expect(await readTeardownCommands(dir)).toEqual([]);
  });
});

describe("runWorktreeTeardown", () => {
  it("runs each command in the worktree", async () => {
    const dir = await worktreeWith({ worktree: { teardown: ["echo one > first.txt", "echo two > second.txt"] } });
    const result = await runWorktreeTeardown({ dir, repo: dir });
    expect(result).toEqual({ ran: ["echo one > first.txt", "echo two > second.txt"], failed: [] });
    await access(path.join(dir, "first.txt"));
    await access(path.join(dir, "second.txt"));
  });

  it("reports a failing command with its exit code and output, and still runs the rest", async () => {
    const dir = await worktreeWith({ worktree: { teardown: ["echo broken >&2; exit 3", "echo after > after.txt"] } });
    const result = await runWorktreeTeardown({ dir, repo: dir });
    expect(result.ran).toEqual(["echo after > after.txt"]);
    expect(result.failed).toEqual([{ command: "echo broken >&2; exit 3", reason: "exit 3: broken" }]);
    await access(path.join(dir, "after.txt"));
  });

  it("kills a command that runs past its timeout", async () => {
    const dir = await worktreeWith({ worktree: { teardown: "sleep 30" } });
    const result = await runWorktreeTeardown({ dir, repo: dir, timeoutMs: 200 });
    expect(result.ran).toEqual([]);
    expect(result.failed).toEqual([{ command: "sleep 30", reason: "timed out after 0s" }]);
  });

  it("does nothing when the directory is gone", async () => {
    const dir = await worktreeWith(undefined);
    await rm(dir, { recursive: true, force: true });
    expect(await runWorktreeTeardown({ dir, repo: dir })).toEqual({ ran: [], failed: [] });
  });
});
