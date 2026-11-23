import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutSnapshot, checkoutViolationSince, freshenCheckout, freshRef } from "./git";

const run = promisify(execFile);
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd })).stdout.trim();
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "git-"));
  temps.push(dir);
  await git(dir, "init", "-q");
  await writeFile(path.join(dir, "a"), "1");
  await git(dir, "add", "a");
  await git(dir, "commit", "-qm", "one");
  return dir;
}

describe("freshRef", () => {
  it("branch off origin's copy, fetched, when the local branch is behind", async () => {
    const origin = await repo();
    const clone = await mkdtemp(path.join(tmpdir(), "git-"));
    temps.push(clone);
    await git(clone, "clone", "-q", origin, ".");
    await writeFile(path.join(origin, "b"), "2");
    await git(origin, "add", "b");
    await git(origin, "commit", "-qm", "two");
    expect(await freshRef(clone, "main")).toBe("origin/main");
    expect(await git(clone, "rev-parse", "origin/main")).toBe(await git(origin, "rev-parse", "main"));
    expect(await git(clone, "rev-parse", "main")).not.toBe(await git(origin, "rev-parse", "main"));
  });

  it("keep the branch itself without an origin", async () => {
    expect(await freshRef(await repo(), "main")).toBe("main");
  });

  it("reads a branch that starts with - as a ref, not as a fetch option", async () => {
    const origin = await repo();
    const clone = await mkdtemp(path.join(tmpdir(), "git-"));
    temps.push(clone);
    await git(clone, "clone", "-q", origin, ".");
    const bin = await mkdtemp(path.join(tmpdir(), "git-"));
    temps.push(bin);
    const uploadPack = path.join(bin, "upload-pack");
    await writeFile(uploadPack, `#!/bin/sh\ntouch ${path.join(bin, "ran")}\n`);
    await chmod(uploadPack, 0o755);
    await freshRef(clone, `--upload-pack=${uploadPack}`);
    await expect(stat(path.join(bin, "ran"))).rejects.toThrow(/ENOENT/);
  });
});

describe("freshenCheckout", () => {
  async function stale() {
    const origin = await repo();
    const clone = await mkdtemp(path.join(tmpdir(), "git-"));
    temps.push(clone);
    await git(clone, "clone", "-q", origin, ".");
    await writeFile(path.join(origin, "script.sh"), "#!/bin/sh\n");
    await git(origin, "add", "script.sh");
    await git(origin, "commit", "-qm", "adds the script");
    return { origin, clone };
  }

  it("fast-forwards a checkout that is behind origin, so a file added there exists", async () => {
    const { origin, clone } = await stale();
    expect(await freshenCheckout(clone, "main")).toEqual({ updated: true, note: null });
    expect(await git(clone, "rev-parse", "HEAD")).toBe(await git(origin, "rev-parse", "main"));
    expect(await git(clone, "ls-files", "script.sh")).toBe("script.sh");
    expect(await freshenCheckout(clone, "main")).toEqual({ updated: false, note: null });
  });

  it("never throws: a diverged checkout, and one without an origin, stay as they are with a note", async () => {
    const { clone } = await stale();
    await writeFile(path.join(clone, "local"), "x");
    await git(clone, "add", "local");
    await git(clone, "commit", "-qm", "local work");
    const head = await git(clone, "rev-parse", "HEAD");
    expect((await freshenCheckout(clone, "main")).note).toMatch(/could not fast-forward to origin\/main/);
    expect(await git(clone, "rev-parse", "HEAD")).toBe(head);
    const alone = await repo();
    expect(await freshenCheckout(alone, "main")).toMatchObject({ updated: false, note: expect.stringMatching(/could not fetch origin\/main/) });
  });
});

describe("checkoutViolationSince", () => {
  it("accepts a fast-forward of HEAD, flags a rewind and a changed file", async () => {
    const dir = await repo();
    const base = await git(dir, "rev-parse", "HEAD");
    const baseline = (await checkoutSnapshot(dir))!;
    expect(await checkoutViolationSince(dir, baseline)).toBeNull();
    await writeFile(path.join(dir, "b"), "2");
    await git(dir, "add", "b");
    await git(dir, "commit", "-qm", "two");
    expect(await checkoutViolationSince(dir, baseline)).toBeNull();
    const forward = (await checkoutSnapshot(dir))!;
    await git(dir, "reset", "-q", "--hard", base);
    expect(await checkoutViolationSince(dir, forward)).toMatch(/HEAD moved/);
    await git(dir, "reset", "-q", "--hard", "HEAD@{1}");
    await writeFile(path.join(dir, "c"), "3");
    expect(await checkoutViolationSince(dir, baseline)).toMatch(/changed files: c/);
  });
});
