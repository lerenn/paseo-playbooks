import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * The live usage log: one JSON line per agent turn, appended to `<data dir>/usage/usage-YYYY-MM.jsonl`
 * (the UTC month of the row), never rewritten. Only counters and identifiers go in: no prompt, message
 * or tool output. Decision: docs/adrs/2026-11-24-usage-log.md.
 */
export type UsageRowKind = "step" | "decider" | "manager" | "sidekick" | "other";
export type UsageRetry = "recheck" | "feedback" | "poll" | "interrupted";

/** One agent turn. `delta` is what the turn added (see `usageDelta`); `contextUsed` is the context size after it. */
export interface UsageRow {
  v: 1;
  ts: string;
  agentId: string;
  /** The agent's turns counted by the ledger, this one included (1 for its first). */
  turnSeq: number;
  runId: string | null;
  playbook: string | null;
  step: string | null;
  /** The step attempt's number (`n`); null for anything but a step. */
  attempt: number | null;
  role: string | null;
  tier: string | null;
  provider: string | null;
  model: string | null;
  kind: UsageRowKind;
  delta: { input: number; cacheRead: number; cacheWrite: null; output: number };
  contextUsed: number;
  costUsd: number | null;
  retry: UsageRetry | null;
}

/** A step attempt ended: join with the turn rows on `agentId`, `runId`, `step`, `attempt`. A reopened attempt (nudge_step) can end again: the last row wins. */
export interface AttemptEndRow {
  v: 1;
  type: "attempt_end";
  ts: string;
  agentId: string;
  runId: string;
  step: string;
  attempt: number;
  outcome: string;
}

export type UsageLogRow = UsageRow | AttemptEndRow;

export const USAGE_DIR = "usage";

/** `usage-YYYY-MM.jsonl`: the file a row stamped `ts` belongs to (UTC month). */
export function usageFileName(ts: string): string {
  return `usage-${new Date(ts).toISOString().slice(0, 7)}.jsonl`;
}

/** Appends rows, one at a time in call order, so lines never interleave. A failure is logged once and never thrown. */
export class UsageLogWriter {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly dir: string) {}

  append(row: UsageLogRow): Promise<void> {
    const line = `${JSON.stringify(row)}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await appendFile(path.join(this.dir, usageFileName(row.ts)), line, "utf8");
      } catch (error) {
        if (!this.failed) console.error(`[playbooks] the usage log could not be written (further failures are not reported): ${(error as Error).message}`);
        this.failed = true;
      }
    });
    return this.queue;
  }

  /** Waits for the rows queued so far. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Debug line with the log's total size (call at startup). */
  async logSize(): Promise<void> {
    try {
      const names = (await readdir(this.dir)).filter((name) => /^usage-\d{4}-\d{2}\.jsonl$/.test(name));
      let bytes = 0;
      for (const name of names) bytes += (await stat(path.join(this.dir, name))).size;
      console.debug(`[playbooks] usage log: ${names.length} file(s), ${(bytes / 1_048_576).toFixed(2)} MB in ${this.dir}`);
    } catch {
      /* no log yet */
    }
  }
}

const toMs = (value: Date | string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? fallback : ms;
};

/**
 * Streams the rows of `dir` (the `usage` directory) with `from <= ts < to`, oldest file first, in file order.
 * Lines that are not valid JSON (a torn last line) are skipped.
 */
export async function* readUsageLog(dir: string, range: { from?: Date | string; to?: Date | string } = {}): AsyncGenerator<UsageLogRow> {
  const from = toMs(range.from, -Infinity);
  const to = toMs(range.to, Infinity);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^usage-\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const month = name.slice(6, 13);
    const start = Date.parse(`${month}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    if (end.getTime() <= from || start >= to) continue;
    const lines = createInterface({ input: createReadStream(path.join(dir, name), { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row: UsageLogRow;
      try {
        row = JSON.parse(line) as UsageLogRow;
      } catch {
        continue;
      }
      const at = Date.parse(row.ts);
      if (at >= from && at < to) yield row;
    }
  }
}
