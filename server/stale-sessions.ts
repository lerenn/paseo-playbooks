import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { reloadStaleSessionsSetting } from "./loader";

type PaseoApi = PluginHandlerContext["paseo"];

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
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = (message) => console.log(`[playbooks] ${message}`),
  ) {}

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
  async reloadIfStale(paseo: PaseoApi, agentId: string, options: { known?: boolean } = {}): Promise<boolean> {
    try {
      await this.load();
      if (this.attempted.has(agentId)) return false;
      const recorded = this.seen.get(agentId);
      if (recorded === this.generation) return false;
      if (recorded === undefined && !options.known) return false;
      const current = await paseo.agents.ref(agentId).refresh();
      const agent = current?.agent;
      if (!agent || agent.archivedAt) return false;
      // Only an idle agent: a reload cancels the turn in progress, and a session
      // with a pending permission or question is waiting for a human.
      if (agent.status !== "idle") return false;
      if ((agent.pendingPermissions?.length ?? 0) > 0) return false;
      if (agent.activeTurn) return false;
      if (!(await reloadSetting(agent.cwd))) return false;
      this.attempted.add(agentId);
      this.log(`reloading the session of agent ${agentId}: it holds tools from an older plugin generation (${recorded ?? "unrecorded"} -> ${this.generation})`);
      await paseo.agents.ref(agentId).reload();
      // The reload reopens the session, which records the new generation; this covers a hook that did not run.
      await this.noteOpened(agentId);
      return true;
    } catch (error) {
      this.log(`could not reload the session of agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
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
