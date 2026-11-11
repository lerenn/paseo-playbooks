import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDir, legacyDataDir, migrateDataDir, pluginDataDir } from "./data-dir";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PASEO_HOME;
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pb-data-"));
});
afterEach(() => {
  if (saved === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = saved;
});

describe("data dir", () => {
  it("uses the namespaced path when there is no old data", () => {
    migrateDataDir();
    expect(pluginDataDir()).toBe(dataDir());
  });

  it("moves old data and leaves a symlink at the old path", () => {
    mkdirSync(legacyDataDir(), { recursive: true });
    writeFileSync(path.join(legacyDataDir(), "config.yaml"), "a: 1\n");
    expect(pluginDataDir()).toBe(legacyDataDir());
    migrateDataDir();
    expect(pluginDataDir()).toBe(dataDir());
    expect(readFileSync(path.join(dataDir(), "config.yaml"), "utf8")).toBe("a: 1\n");
    expect(lstatSync(legacyDataDir()).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(legacyDataDir(), "config.yaml"), "utf8")).toBe("a: 1\n");
  });

  it("leaves both alone when the new directory already exists", () => {
    mkdirSync(legacyDataDir(), { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    migrateDataDir();
    expect(lstatSync(legacyDataDir()).isSymbolicLink()).toBe(false);
    expect(pluginDataDir()).toBe(dataDir());
  });
});
