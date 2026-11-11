import { mkdtemp, readFile, rm, stat, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveAttachment, safeFileName } from "./attachments";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "att-"));
  temps.push(dir);
  return dir;
};

describe("saving an attachment", () => {
  it("writes the bytes under the directory and returns the path", async () => {
    const dir = await tempDir();
    const target = await saveAttachment({ fileName: "notes.txt", dataBase64: Buffer.from("hello").toString("base64") }, dir);
    expect(target.startsWith(dir)).toBe(true);
    expect(path.basename(target)).toBe("notes.txt");
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("cannot escape the directory through the file name", async () => {
    const dir = await tempDir();
    const target = await saveAttachment({ fileName: "../../etc/passwd", dataBase64: Buffer.from("x").toString("base64") }, dir);
    expect(path.dirname(path.dirname(target))).toBe(dir);
    expect(safeFileName("..\\..\\.bashrc")).toBe("bashrc");
    expect(safeFileName("")).toBe("file");
  });

  it("refuses an empty file", async () => {
    await expect(saveAttachment({ fileName: "a", dataBase64: "" }, await tempDir())).rejects.toThrow(/empty/);
  });

  it("removes uploads older than a week", async () => {
    const dir = await tempDir();
    const old = path.join(dir, "old");
    await mkdir(old);
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await utimes(old, past, past);
    await saveAttachment({ fileName: "a", dataBase64: "eA==" }, dir);
    await expect(stat(old)).rejects.toThrow();
  });
});
