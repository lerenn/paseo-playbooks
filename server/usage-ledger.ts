import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AgentUsage, AgentUsageSchema } from "../shared/analytics";
import { addUsage, type Usage, type UsageReading, usageDelta, UsageSchema } from "../shared/types";

export type AgentUsageInfo = Omit<AgentUsage, "usage" | "last" | "agentId" | "at">;

/**
 * What every agent that ended a turn spent, kept per agent id (`agent-usage.json`): the last cumulative
 * reading, to turn the next one into a delta, and the sum of the deltas. A manager keeps one agent across
 * runs and the daemon's usage is per session, so the delta must not depend on the run.
 */
export class UsageLedger {
  private readonly agents = new Map<string, AgentUsage>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then(
      (text) => {
        try {
          for (const raw of Object.values(JSON.parse(text) as Record<string, unknown>)) {
            const parsed = AgentUsageSchema.safeParse(raw);
            if (parsed.success) this.agents.set(parsed.data.agentId, parsed.data);
          }
        } catch {
          /* unreadable: start empty */
        }
      },
      () => undefined,
    );
    return this.loaded;
  }

  /** Records a turn's cumulative reading; returns what this turn added. */
  async record(agentId: string, info: AgentUsageInfo, reading: UsageReading, at = new Date().toISOString()): Promise<UsageReading> {
    await this.load();
    const before = this.agents.get(agentId);
    const delta = usageDelta(before?.last, reading);
    const usage: Usage = addUsage(before?.usage ?? UsageSchema.parse({}), delta);
    this.agents.set(agentId, { ...info, agentId, at, last: reading, usage });
    this.save();
    return delta;
  }

  async list(): Promise<AgentUsage[]> {
    await this.load();
    return [...this.agents.values()];
  }

  private save(): void {
    const body = `${JSON.stringify(Object.fromEntries(this.agents), null, 2)}\n`;
    this.writing = this.writing
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(temp, body, "utf8");
        await rename(temp, this.file);
      })
      .catch(() => undefined);
  }

  /** Waits for the write in flight. */
  flush(): Promise<void> {
    return this.writing;
  }
}
