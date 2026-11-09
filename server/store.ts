import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { RunSchema, type Run } from "../shared/types";

/** `$PASEO_HOME/plugin-data/paseo-playbooks/runs`, outside the plugins folder Paseo manages. */
export function defaultRunsDir(): string {
  const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
  return path.join(home, "plugin-data", "paseo-playbooks", "runs");
}

/**
 * One JSON file per run, written atomically (temp file, then rename). Mutations of a run
 * are serialized, so concurrent hooks and tool calls never interleave writes.
 */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Writes in flight, awaited by close. */
  private readonly writing = new Set<Promise<void>>();
  private closed = false;

  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = RunSchema.parse(JSON.parse(await readFile(path.join(this.dir, name), "utf8")));
        this.runs.set(run.id, run);
      } catch (error) {
        console.error(`[playbooks] skipping unreadable run file ${name}:`, (error as Error).message);
      }
    }
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /** Runs one mutation at a time per run, then persists. The callback's result is returned. */
  mutate<T>(id: string, fn: (run: Run) => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const run = this.runs.get(id);
      if (!run) throw new Error(`unknown run "${id}"`);
      const working = structuredClone(run);
      const result = await fn(working);
      await this.write(working);
      this.runs.set(id, working);
      return result;
    });
    this.queues.set(id, next.catch(() => undefined));
    return next;
  }

  async create(run: Run): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`run "${run.id}" already exists`);
    await this.write(run);
    this.runs.set(run.id, run);
  }

  async delete(id: string): Promise<void> {
    await (this.queues.get(id) ?? Promise.resolve());
    this.runs.delete(id);
    this.queues.delete(id);
    await rm(path.join(this.dir, `${id}.json`), { force: true });
  }

  /** Stops writing (mutations still apply in memory) and waits for the writes in flight. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.writing);
  }

  private async write(run: Run): Promise<void> {
    if (this.closed) return;
    const file = path.join(this.dir, `${run.id}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    const done = writeFile(temp, `${JSON.stringify(run, null, 2)}\n`, "utf8").then(() => rename(temp, file));
    this.writing.add(done);
    try {
      await done;
    } finally {
      this.writing.delete(done);
    }
  }
}
