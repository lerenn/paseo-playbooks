import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Playbook, PlaybookEntry, RunDefinition } from "../shared/types";
import { defaultBranch, exportPaths, freshRefInfo, resolveCommit } from "./git";
import { loadPlaybooks, PLAYBOOKS_DIRS, type LoadOptions, type LoadResult } from "./loader";

const exec = promisify(execFile);

/** A playbook a fresh checkout may replace the workspace's copy with: valid, isolated and not a singleton. */
export function isAdoptable(entry: PlaybookEntry | undefined): entry is PlaybookEntry & { playbook: Playbook } {
  return Boolean(entry?.playbook && entry.playbook.isolation.mode === "worktree" && !entry.playbook.singleton);
}

/**
 * The definition an isolated run starts with: the one read from its worktree (off a freshly fetched
 * origin/<base>) when that is a valid isolated playbook of the same id, else the workspace checkout's, with the reason.
 */
export async function chooseDefinition(input: {
  projectId: string;
  playbook: Playbook;
  worktreeDir: string;
  baseRef: string;
  baseSha: string;
  fetchError: string | null;
}): Promise<{ playbook: Playbook; definition: RunDefinition }> {
  const fallback = (note: string, why: string) => ({ playbook: input.playbook, definition: { source: "workspace" as const, ref: null, sha: null, note, warning: workspaceWarning(why) } });
  if (input.fetchError) return fallback(`could not fetch ${input.baseRef} (${input.fetchError}); using the workspace checkout's playbook`, `${input.baseRef} could not be fetched: ${shortReason(input.fetchError)}`);
  let entry: PlaybookEntry | undefined;
  try {
    entry = (await loadPlaybooks(input.worktreeDir, { projectId: input.projectId })).entries.find((candidate) => candidate.id === input.playbook.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallback(`could not read the playbooks of ${input.baseRef} (${reason}); using the workspace checkout's playbook`, `the playbooks of ${input.baseRef} could not be read: ${shortReason(reason)}`);
  }
  if (!entry) return fallback(`${input.baseRef} has no playbook "${input.playbook.id}"; using the workspace checkout's`, `${input.baseRef} has no playbook "${input.playbook.id}"`);
  if (!entry.playbook) return fallback(`playbook "${input.playbook.id}" is invalid on ${input.baseRef} (${entry.errors[0] ?? "unknown error"}); using the workspace checkout's`, `${input.baseRef} is invalid: ${shortReason(entry.errors[0] ?? "unknown error")}`);
  if (!isAdoptable(entry)) return fallback(`playbook "${input.playbook.id}" on ${input.baseRef} is no longer an isolated, non-singleton playbook; using the workspace checkout's`, `"${input.playbook.id}" on ${input.baseRef} is no longer an isolated, non-singleton playbook`);
  return { playbook: entry.playbook, definition: { source: "origin", ref: input.baseRef, sha: input.baseSha, note: null, warning: null } };
}

/** The first line of an error, cut to a short reason a warning can carry. */
export function shortReason(text: string, max = 200): string {
  const line = text.split("\n").find((candidate) => candidate.trim())?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The warning of a run whose definition came from the workspace checkout instead of origin. */
export function workspaceWarning(why: string): string {
  return `definition read from the workspace checkout because ${why}`;
}

/**
 * Whether a re-read playbook can replace a run's pinned one without breaking the run's recorded state: the same
 * steps (ids, kinds, needs, after-task membership) in the same order. Everything else (scripts, outputs, timeouts,
 * prompts, defaults) may change. Null when compatible, else what differs.
 */
export function definitionMismatch(pinned: Playbook, next: Playbook): string | null {
  const shape = (playbook: Playbook) => playbook.steps.map((step) => `${step.id}|${step.kind}|${[...step.needs].sort().join(",")}|${step.afterTask ?? ""}`);
  const before = shape(pinned);
  const after = shape(next);
  if (before.join("\n") === after.join("\n")) return null;
  const ids = new Set(pinned.steps.map((step) => step.id));
  const added = next.steps.filter((step) => !ids.has(step.id)).map((step) => step.id);
  const nextIds = new Set(next.steps.map((step) => step.id));
  const removed = pinned.steps.filter((step) => !nextIds.has(step.id)).map((step) => step.id);
  const parts = [added.length > 0 ? `new steps: ${added.join(", ")}` : "", removed.length > 0 ? `removed steps: ${removed.join(", ")}` : ""].filter(Boolean);
  return `the step graph changed (${parts.join("; ") || "kinds, needs or order differ"})`;
}

export interface ResolvedEntry {
  entry: PlaybookEntry;
  /** What a new run would load: `origin` (fresh base, isolated playbooks) or the `workspace` checkout. */
  source: "origin" | "workspace";
  ref?: string;
  note?: string;
}

/** The playbooks of `ref` (a ref already fetched), read without a checkout; or why not. */
export async function readAtRef(dir: string, ref: string, options: LoadOptions): Promise<{ sha: string; loaded: LoadResult } | { error: string }> {
  const tmp = await mkdtemp(path.join(tmpdir(), "playbooks-fresh-"));
  try {
    await exportPaths(dir, ref, PLAYBOOKS_DIRS, tmp);
    const sha = await resolveCommit(dir, ref);
    return { sha, loaded: await loadPlaybooks(tmp, options) };
  } catch (error) {
    return { error: `could not read the playbooks of ${ref} (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The playbooks of `base` on origin (fetched), read without a checkout; or why not. */
async function loadAtRef(dir: string, base: string, activeProfiles: string[], defaultActive: boolean): Promise<{ ref: string; sha: string; loaded: LoadResult } | { error: string }> {
  const { ref, fetchError } = await freshRefInfo(dir, base);
  if (fetchError) return { error: `could not fetch ${ref} (${fetchError})` };
  const read = await readAtRef(dir, ref, { activeProfiles, defaultActive });
  return "error" in read ? read : { ref, ...read };
}

/**
 * The entries of `workspaceDir` as a new run would load them: an isolated playbook comes from its base branch on
 * origin (what `start_playbook` reads from the run's worktree), anything else from the workspace checkout.
 * A playbook whose fresh copy is missing, invalid or unreachable stays the workspace's, with a note.
 */
export async function resolveForNewRun(workspaceDir: string, workspace: LoadResult): Promise<ResolvedEntry[]> {
  const bases = new Map<string, string | null>();
  for (const entry of workspace.entries) {
    if (!isAdoptable(entry)) continue;
    bases.set(entry.id, entry.playbook.isolation.base ?? (await defaultBranch(workspaceDir)));
  }
  const activeProfiles = workspace.profiles.filter((profile) => profile.active).map((profile) => profile.id);
  const cache = new Map<string, Awaited<ReturnType<typeof loadAtRef>>>();
  const out: ResolvedEntry[] = [];
  for (const entry of workspace.entries) {
    const base = bases.get(entry.id);
    if (!base) {
      out.push({ entry, source: "workspace" });
      continue;
    }
    if (!cache.has(base)) cache.set(base, await loadAtRef(workspaceDir, base, activeProfiles, workspace.defaultActive));
    const fresh = cache.get(base)!;
    if ("error" in fresh) {
      out.push({ entry, source: "workspace", note: `${fresh.error}; a new run would use the workspace checkout's playbook` });
      continue;
    }
    const copy = fresh.loaded.entries.find((candidate) => candidate.id === entry.id);
    if (!copy) out.push({ entry, source: "workspace", note: `${fresh.ref} has no playbook "${entry.id}"; a new run would use the workspace checkout's` });
    else if (!copy.playbook) out.push({ entry: copy, source: "origin", ref: fresh.ref, note: `invalid on ${fresh.ref}: a new run would fall back to the workspace checkout's copy (which is valid)` });
    else if (!isAdoptable(copy)) out.push({ entry, source: "workspace", note: `on ${fresh.ref} it is no longer an isolated, non-singleton playbook; a new run would use the workspace checkout's` });
    else out.push({ entry: copy, source: "origin", ref: fresh.ref });
  }
  return out;
}
