/** What the Sidekick composer accepts from the human: limits, the image/file split and the prompt text. */

/** Image types agents take as image content blocks (what Paseo's own composer sends). */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = "image" | "file";

export interface Candidate {
  name: string;
  mimeType: string;
  size: number;
}

export function attachmentKind(mimeType: string): AttachmentKind {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase()) ? "image" : "file";
}

/** Executables and installers are refused: the agent has no use for them and they are a risk to open. */
const BLOCKED_EXTENSIONS = new Set(["exe", "dll", "msi", "bat", "cmd", "com", "scr", "app", "dmg", "apk", "jar", "so", "dylib"]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The reason a candidate cannot join the `current` attachments, or null when it can. */
export function refusal(current: Candidate[], candidate: Candidate): string | null {
  if (current.length >= MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} attachments per message`;
  if (candidate.size === 0) return `${candidate.name} is empty`;
  if (BLOCKED_EXTENSIONS.has(extensionOf(candidate.name))) return `${candidate.name}: this file type is not accepted`;
  const kind = attachmentKind(candidate.mimeType);
  const max = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (candidate.size > max) return `${candidate.name} is ${formatSize(candidate.size)}; the limit is ${formatSize(max)} for ${kind === "image" ? "images" : "files"}`;
  if (current.reduce((sum, item) => sum + item.size, 0) + candidate.size > MAX_TOTAL_BYTES) return `Attachments are limited to ${formatSize(MAX_TOTAL_BYTES)} in total`;
  return null;
}

/** The message text: what the human typed, then one line per saved file naming its path (images travel as image blocks). */
export function promptWithFiles(text: string, files: Array<{ name: string; path: string }>): string {
  if (files.length === 0) return text;
  const lines = files.map((file) => `- ${file.name}: ${file.path}`);
  return `${text}${text ? "\n\n" : ""}Attached files (saved on the host; read them by path):\n${lines.join("\n")}`;
}
