import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Backoff, describeRemovalError } from "./backoff";

describe("Backoff", () => {
  it("waits longer after each failure and gives up after the last delay", () => {
    const backoff = new Backoff([10, 20]);
    expect(backoff.ready("a", 0)).toBe(true);
    expect(backoff.fail("a", 0)).toEqual({ attempt: 1, waitMs: 10 });
    expect(backoff.ready("a", 5)).toBe(false);
    expect(backoff.ready("a", 10)).toBe(true);
    expect(backoff.fail("a", 10)).toEqual({ attempt: 2, waitMs: 20 });
    expect(backoff.ready("a", 29)).toBe(false);
    expect(backoff.fail("a", 30)).toEqual({ attempt: 3, waitMs: null });
    expect(backoff.ready("a", 30)).toBe(true);
  });

  it("keeps keys apart and forgets a key that succeeded", () => {
    const backoff = new Backoff([10]);
    backoff.fail("a", 0);
    expect(backoff.ready("b", 1)).toBe(true);
    backoff.clear("a");
    expect(backoff.ready("a", 1)).toBe(true);
    expect(backoff.fail("a", 1).attempt).toBe(1);
  });
});

describe("describeRemovalError", () => {
  it("names the owner when a permission error is about a path another user owns", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) return;
    const error = Object.assign(new Error("EACCES: permission denied, rmdir '/'"), { code: "EACCES", path: "/" });
    expect(await describeRemovalError(error)).toMatch(/owned by uid 0, the plugin runs as uid \d+/);
  });

  it("leaves other errors as they are", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "backoff-"));
    try {
      expect(await describeRemovalError(new Error("boom"))).toBe("boom");
      const own = Object.assign(new Error("EACCES"), { code: "EACCES", path: dir });
      expect(await describeRemovalError(own)).toBe("EACCES");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
