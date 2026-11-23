import { createHash } from "node:crypto";

/**
 * Dismissed review findings (ADR 2026-11-23-dismiss-finding): the signature that identifies a finding across heads, the PR reference
 * form, and the guardrails that keep some findings with a human. Pure functions, so callers can compute the same values.
 */

/** Characters of the normalised finding text the signature covers: a bot's later elaboration does not change it. */
export const SIGNATURE_TEXT_MAX = 300;
export const SIGNATURE_PREFIX = "fs1:";

/** `src/a.ts`, `./src/a.ts`, `/src/a.ts` and `src\a.ts` are one file. Case is kept (paths are case-sensitive). */
export function normalizeFindingFile(file: string): string {
  return file.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

/**
 * The finding text as compared: NFKC, lower case, markdown links and images reduced to their label or dropped, severity badges
 * (`P2`, "Badge"), line references (`L42`, "line 42", `:42`) and bare numbers dropped (they move between heads), every run of
 * other characters one space, cut at SIGNATURE_TEXT_MAX characters.
 */
export function normalizeFindingText(text: string): string {
  const flat = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\bp[0-3]\b|\bbadge\b/g, " ")
    .replace(/\blines?\s+\d+(\s*[-–]\s*\d+)?|\bl\d+(\s*[-–]\s*l?\d+)?\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word !== "" && !/^\d+$/.test(word))
    .join(" ");
  return flat.slice(0, SIGNATURE_TEXT_MAX).trim();
}

/**
 * The signature of a finding: `fs1:` and the first 16 hex characters of the SHA-256 of `<file>\n<text>`, both normalised as above. It does
 * not depend on the PR, the comment id or the head. From a shell: `printf '%s\n%s' "$file" "$text" | sha256sum | cut -c1-16` gives the hash of
 * ALREADY normalised inputs; the tools return and compare it, so a script only needs `list_dismissed_findings` with `file` and `text`.
 */
export function findingSignature(file: string, text: string): string {
  return SIGNATURE_PREFIX + createHash("sha256").update(`${normalizeFindingFile(file)}\n${normalizeFindingText(text)}`).digest("hex").slice(0, 16);
}

/** A PR as `owner/repo#N` (lower case) from a GitHub URL (`…/pull/N`), `owner/repo#N` or `owner/repo/pull/N`; anything else is trimmed and kept as is. */
export function normalizePr(pr: string): string {
  const text = pr.trim();
  const match = /^(?:https?:\/\/[^/]+\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)(?:[/?#].*)?$/i.exec(text);
  return match ? `${match[1]!.toLowerCase()}#${match[2]}` : text;
}

const SEVERE = new Set(["p0", "p1", "critical", "blocker", "high", "major"]);
const MINOR = new Set(["p2", "p3", "medium", "moderate", "low", "minor", "nit", "nitpick", "info", "suggestion"]);
/** Whole words of a category (split at anything that is not a letter or digit) that keep a finding with a human. */
const SENSITIVE = /^(security|secur\w*|auth\w*|oauth\w*|secrets?|credentials?|iam|migrations?|migrat\w*)$/;

/**
 * Why a finding may not be dismissed by an agent, or null when it may. Severity and category are required; a P0/P1 (or critical, high...)
 * and a severity that is not recognised go to a human; so does a category with a word of security, auth, secrets, credentials, IAM or migration.
 */
export function dismissRefusal(severity: string, category: string): string | null {
  const sev = severity.trim().toLowerCase();
  const words = category.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!sev) return "severity is required: a finding without one goes to a human";
  if (words.length === 0) return "category is required: a finding without one goes to a human";
  if (SEVERE.has(sev)) return `a ${severity.trim()} finding is not dismissed by an agent: a human decides it`;
  if (!MINOR.has(sev)) return `severity "${severity.trim()}" is not recognised (P2, P3, medium, low, minor, nit, info, suggestion): a human decides it`;
  const hit = words.find((word) => SENSITIVE.test(word));
  if (hit) return `category "${category.trim()}" (${hit}) is not dismissed by an agent: security, auth, secrets, credentials, IAM and migration findings go to a human`;
  return null;
}
