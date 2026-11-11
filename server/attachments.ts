import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_FILE_BYTES } from "../shared/attachments";

/** Where the Sidekick's pasted files are saved: a temp dir, one folder per upload. */
export const ATTACHMENTS_DIR = path.join(tmpdir(), "paseo-playbooks-attachments");
const KEEP_MS = 7 * 24 * 3600 * 1000;

/** A file name that is safe as a path segment: no directories, no leading dots, no odd characters. */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return cleaned || "file";
}

/** Saves one file and returns its absolute path; uploads older than a week are removed on the way. */
export async function saveAttachment(input: { fileName: string; dataBase64: string }, dir = ATTACHMENTS_DIR): Promise<string> {
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (bytes.length === 0) throw new Error("The file is empty");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("The file is too large");
  await prune(dir).catch(() => undefined);
  const folder = path.join(dir, randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = path.join(folder, safeFileName(input.fileName));
  await writeFile(target, bytes, { mode: 0o600 });
  return target;
}

async function prune(dir: string): Promise<void> {
  const cutoff = Date.now() - KEEP_MS;
  for (const entry of await readdir(dir)) {
    const folder = path.join(dir, entry);
    if ((await stat(folder)).mtimeMs < cutoff) await rm(folder, { recursive: true, force: true });
  }
}
