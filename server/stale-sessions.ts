import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { Backoff } from "./backoff";
import { reloadStaleSessionsSetting } from "./loader";

type PaseoApi = PluginHandlerContext["paseo"];

export type ReloadOptions = { known?: boolean; /** No log line: the caller reports a summary. */ quiet?: boolean };
/** `current`: nothing to do; `busy`: not now (mid-turn, asking, or waiting to retry); `gone`: its working directory no longer exists. */
export type ReloadOutcome = { kind: "reloaded" | "current" | "busy" | "gone" } | { kind: "failed"; reason: string };

/**
 * Which plugin generation each agent's session was opened under (`agent.session_open` attaches the
 * plugin's tools then), and the reload of sessions left behind by a plugin reload.
 *
 * A running Claude session keeps the tool list it connected with, so after a plugin reload its
 * calls to the plugin's tools fail with "Tool X not found". The daemon repairs that on the agent's
 * next prompt, but not for an agent mid-turn. The plugin reloads such a session itself, through
 * the non-agent path (`agents.ref(id).reload()`, which keeps history), once the agent is idle.
 *
 * A generation is one load of the plugin (one `StaleSessions` instance). It is not persisted;
 * the per-agent record is, because a reload starts a new process with an empty memory.
 */
export class StaleSessions {
  readonly generation = randomUUID();
  private readonly seen = new Map<string, string>();
  /** Agents already reloaded (or tried) in this generation: never a second time. */
  private readonly attempted = new Set<string>();
  /** Agents whose reload failed for a transient reason: when the next try may start. */
  private readonly retries: Backoff;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = (message) => console.log(`[playbooks] ${message}`),
    /** Delay before each retry of a failed reload; its length is the number of retries. */
    private readonly backoffMs: readonly number[] = [5_000, 20_000, 60_000, 180_000],
  ) {
    this.retries = new Backoff(backoffMs);
  }

  private load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then(
      (text) => {
        try {
          for (const [id, generation] of Object.entries(JSON.parse(text) as Record<string, string>)) this.seen.set(id, generation);
        } catch {
          /* unreadable: start empty */
        }
      },
      () => undefined,
    );
    return this.loaded;
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify(Object.fromEntries(this.seen), null, 2)}\n`;
    this.writing = this.writing
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(temp, body, "utf8");
        await rename(temp, this.file);
      })
      .catch(() => undefined);
    return this.writing;
  }

  /** The agent's session was just opened with this generation's tools. */
  async noteOpened(agentId: string): Promise<void> {
    await this.load();
    if (this.seen.get(agentId) === this.generation) return;
    this.seen.set(agentId, this.generation);
    await this.save();
  }

  async forget(agentId: string): Promise<void> {
    await this.load();
    if (this.seen.delete(agentId)) await this.save();
  }

  /** Waits for the record written in flight. */
  flush(): Promise<void> {
    return this.writing;
  }

  /**
   * Reloads the agent's session when it holds an older generation's tools (or, with `known`, when
   * it is a run's agent with no record, which predates the record) and is idle. Returns whether
   * it reloaded. Never throws.
   */
  async reloadIfStale(paseo: PaseoApi, agentId: string, options: ReloadOptions = {}): Promise<boolean> {
    return (await this.tryReload(paseo, agentId, options)).kind === "reloaded";
  }

  /**
   * Like `reloadIfStale`, with the outcome. A reload that fails for a transient reason is retried
   * with a growing delay (`backoffMs`), then given up on; an agent whose working directory is gone
   * cannot be reopened at all, so it is skipped quietly. Never throws.
   */
  async tryReload(paseo: PaseoApi, agentId: string, options: ReloadOptions = {}): Promise<ReloadOutcome> {
    try {
      await this.load();
      if (this.attempted.has(agentId)) return { kind: "current" };
      const recorded = this.seen.get(agentId);
      if (recorded === this.generation) return { kind: "current" };
      if (recorded === undefined && !options.known) return { kind: "current" };
      if (!this.retries.ready(agentId)) return { kind: "busy" };
      const current = await paseo.agents.ref(agentId).refresh();
      const agent = current?.agent;
      if (!agent || agent.archivedAt) return { kind: "current" };
      // Only an idle agent: a reload cancels the turn in progress, and a session
      // with a pending permission or question is waiting for a human.
      if (agent.status !== "idle") return { kind: "busy" };
      if ((agent.pendingPermissions?.length ?? 0) > 0) return { kind: "busy" };
      if (agent.activeTurn) return { kind: "busy" };
      if (!(await reloadSetting(agent.cwd))) return { kind: "current" };
      // The daemon reopens a session in its working directory: with that gone (an ended run's
      // worktree), the reload can only fail, now and later. Nothing to repair.
      if (agent.cwd && !existsSync(agent.cwd)) {
        this.attempted.add(agentId);
        return { kind: "gone" };
      }
      if (!options.quiet) this.log(`reloading the session of agent ${agentId}: it holds tools from an older plugin generation (${recorded ?? "unrecorded"} -> ${this.generation})`);
      await paseo.agents.ref(agentId).reload();
      this.retries.clear(agentId);
      this.attempted.add(agentId);
      // The reload reopens the session, which records the new generation; this covers a hook that did not run.
      await this.noteOpened(agentId);
      return { kind: "reloaded" };
    } catch (error) {
      return { kind: "failed", reason: this.noteFailure(paseo, agentId, options, error instanceof Error ? error.message : String(error)) };
    }
  }

  /** Counts the failure, schedules the retry (or gives up) and returns the reason as logged. */
  private noteFailure(paseo: PaseoApi, agentId: string, options: ReloadOptions, reason: string): string {
    const { attempt, waitMs: delay } = this.retries.fail(agentId);
    if (delay === null) {
      this.attempted.add(agentId);
      this.log(`could not reload the session of agent ${agentId}: ${reason}; giving up after ${attempt} attempts`);
      return reason;
    }
    if (!options.quiet) this.log(`could not reload the session of agent ${agentId}: ${reason}; retrying in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.tryReload(paseo, agentId, { ...options, quiet: true });
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.add(timer);
    return reason;
  }

  /** Stops the pending retries (the plugin is shutting down). */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Agents with a record of an older generation. */
  staleIds(): string[] {
    return [...this.seen].filter(([, generation]) => generation !== this.generation).map(([id]) => id);
  }

  has(agentId: string): boolean {
    return this.seen.has(agentId);
  }
}

async function reloadSetting(cwd: string | undefined): Promise<boolean> {
  if (!cwd) return true;
  return reloadStaleSessionsSetting(cwd).catch(() => true);
}
