import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Grace period between the Sidekick being told a subagent finished and the archive of the subagent's workspace, unless `sidekick.subagents.archive_after` says otherwise. */
export const DEFAULT_SUBAGENT_ARCHIVE_AFTER_MS = 10 * 60_000;

/** Longest `archive_after`: a pending archive is a timer, and the grace is meant to be minutes, not days. */
export const MAX_SUBAGENT_ARCHIVE_AFTER_MS = 24 * 3_600_000;

const EntrySchema = z.object({ agentId: z.string(), workspaceId: z.string(), projectId: z.string(), /** Epoch ms from which the workspace may be archived. */ dueAt: z.number() });
export type PendingSubagentArchive = z.infer<typeof EntrySchema>;

/**
 * `sidekick-archive.json` next to the runs: the Sidekick subagents whose workspace waits to be archived, with
 * the time it is due. It survives a plugin reload or a daemon restart: the entries are read again at startup,
 * so nothing is archived before its time and nothing is forgotten.
 */
export class SubagentArchiveStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async all(): Promise<PendingSubagentArchive[]> {
    try {
      const parsed = z.array(EntrySchema).safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /** Adds an entry, or moves the due time of the agent's entry (the subagent finished another turn). Serialized and atomic. */
  upsert(entry: PendingSubagentArchive): Promise<void> {
    return this.change((all) => [...all.filter((other) => other.agentId !== entry.agentId), entry]);
  }

  remove(agentId: string): Promise<void> {
    return this.change((all) => all.filter((entry) => entry.agentId !== agentId));
  }

  private change(fn: (all: PendingSubagentArchive[]) => PendingSubagentArchive[]): Promise<void> {
    const next = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(fn(await this.all()), null, 2));
      await rename(temp, this.file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** The facts the guards look at, gathered by the runtime. `null` means the fact is not known: that refuses. */
export interface SubagentWorkspaceFacts {
  workspace: { id: string; kind: string; background: boolean | null; worktreeSlug: string | null; directory: string | null } | null;
  /** The Sidekick's own (hidden) workspace and the project's root directory. */
  sidekickWorkspaceId: string | null;
  projectRoot: string;
  /** Ids of the workspaces of every run, archived or not. */
  runWorkspaceIds: string[];
  /** Other agents not archived in the workspace (not the subagent itself). */
  otherAgents: string[];
  agent: { status: string; pendingPermissions: number } | null;
  dirty: string[] | null;
  unpushed: string[] | null;
}

/**
 * Why a Sidekick subagent's workspace must NOT be archived, or null when it may be. Ownership first: the only
 * workspaces archived are the ones made for a subagent, a hidden (background) worktree that Paseo manages, never a
 * checkout of the project. Then the same safety checks as `workspace.archive_with_run` and the worktree cleanup:
 * nothing else lives there, nothing is running, nothing is unsaved.
 */
export function subagentWorkspaceRefusal(facts: SubagentWorkspaceFacts): string | null {
  const ws = facts.workspace;
  if (!ws) return null;
  if (ws.kind !== "worktree" || !ws.worktreeSlug) return `it is not a worktree that Paseo manages (kind ${ws.kind}): it may be a checkout of the project`;
  if (ws.background !== true) return "it is a visible workspace, not a hidden one made for a subagent";
  if (ws.id === facts.sidekickWorkspaceId) return "it is the Sidekick's own workspace";
  if (!ws.directory) return "its directory is unknown";
  if (path.resolve(ws.directory) === path.resolve(facts.projectRoot)) return "it is the project's root checkout";
  if (facts.runWorkspaceIds.includes(ws.id)) return "a run uses it";
  if (facts.otherAgents.length > 0) return `another agent lives in it: ${facts.otherAgents.join(", ")}`;
  if (!facts.agent) return "the subagent's state could not be read";
  if (facts.agent.status === "running" || facts.agent.status === "initializing" || facts.agent.pendingPermissions > 0) return "the subagent is running or waits on a permission";
  if (facts.dirty === null) return "its uncommitted changes could not be checked";
  if (facts.dirty.length > 0) return `it has uncommitted changes (${facts.dirty.slice(0, 5).join(", ")}${facts.dirty.length > 5 ? ", …" : ""})`;
  if (facts.unpushed === null) return "its commits could not be checked";
  if (facts.unpushed.length > 0) return `its branch has commits that are not pushed (${facts.unpushed.length})`;
  return null;
}
