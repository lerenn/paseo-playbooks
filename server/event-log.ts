import { appendFile, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENVELOPE_VERSION, genesisType, type DomainEvent, type LoggedEvent } from "./event-core";

/**
 * The event log store: one append-only file per stream (a run), `<dir>/<stream>.events.jsonl`, one
 * JSON envelope per line. An append is one `write` of whole lines to a file opened with O_APPEND, so
 * a crash leaves either complete lines or a torn last line; a torn last line is dropped (and cut off
 * the file) when the stream is opened. Callers serialize the appends of one stream (the run store does,
 * per run). Seq is per stream, 1-based, and survives compaction.
 */

export const LOG_SUFFIX = ".events.jsonl";
/** A stream above this size is compacted at the next append: rewritten as one genesis event per area. */
export const DEFAULT_COMPACT_BYTES = 1024 * 1024;

export interface StreamHead {
  /** Seq of the last event in the file (0: empty). */
  seq: number;
  /** Areas that have a genesis event in the file: their later events are replayable from it. */
  genesis: Set<string>;
  bytes: number;
}

export interface ReadResult {
  events: LoggedEvent[];
  /** A torn (unterminated or unparsable) last line was found. */
  torn: boolean;
  /** Lines skipped in the middle of the file (unparsable, or an envelope version this code does not know). */
  skipped: number;
}

function parseLine(line: string): LoggedEvent | null {
  try {
    const value = JSON.parse(line) as Partial<LoggedEvent>;
    if (value && value.v === ENVELOPE_VERSION && typeof value.stream === "string" && Number.isInteger(value.seq) && typeof value.type === "string" && typeof value.at === "string" && value.data && typeof value.data === "object") return value as LoggedEvent;
  } catch {
    // fall through
  }
  return null;
}

export class EventLog {
  private readonly heads = new Map<string, StreamHead>();

  constructor(readonly dir: string) {}

  file(stream: string): string {
    return path.join(this.dir, `${stream}${LOG_SUFFIX}`);
  }

  /** Reads a stream; tolerates a torn last line and skips unreadable lines. A missing file is an empty stream. */
  async read(stream: string): Promise<ReadResult> {
    let text: string;
    try {
      text = await readFile(this.file(stream), "utf8");
    } catch {
      return { events: [], torn: false, skipped: 0 };
    }
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    const events: LoggedEvent[] = [];
    let skipped = 0;
    for (const line of lines) {
      if (line === "") continue;
      const event = parseLine(line);
      if (event) events.push(event);
      else skipped += 1;
    }
    // After the last newline there should be nothing; text there is a write the crash cut short.
    return { events, torn: tail !== "", skipped };
  }

  /** The stream's head, loaded on first use. A torn last line is cut off the file here, before anything is appended after it. */
  async head(stream: string): Promise<StreamHead> {
    const known = this.heads.get(stream);
    if (known) return known;
    const { events, torn } = await this.read(stream);
    if (torn) await this.cutTornTail(stream);
    const head: StreamHead = {
      seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
      genesis: new Set(),
      bytes: await stat(this.file(stream)).then((info) => info.size, () => 0),
    };
    // An area is replayable from its latest genesis only if nothing before it matters: any genesis in the file will do.
    for (const event of events) if (event.type.endsWith(".genesis")) head.genesis.add(event.type.slice(0, -".genesis".length));
    this.heads.set(stream, head);
    return head;
  }

  private async cutTornTail(stream: string): Promise<void> {
    const file = this.file(stream);
    const text = await readFile(file, "utf8");
    const keep = text.lastIndexOf("\n") + 1;
    await truncate(file, Buffer.byteLength(text.slice(0, keep)));
  }

  /**
   * Appends events as consecutive seqs after the stream's head, in one write. If the write fails the
   * head is forgotten (it is reloaded from disk next time) and the error is thrown.
   */
  async append(stream: string, events: readonly DomainEvent[]): Promise<LoggedEvent[]> {
    const head = await this.head(stream);
    const logged: LoggedEvent[] = events.map((event, i) => ({ v: ENVELOPE_VERSION, stream, seq: head.seq + 1 + i, type: event.type, at: event.at, data: event.data }));
    const text = logged.map((event) => `${JSON.stringify(event)}\n`).join("");
    try {
      await appendFile(this.file(stream), text, "utf8");
    } catch (error) {
      this.heads.delete(stream);
      throw error;
    }
    head.seq = logged.at(-1)?.seq ?? head.seq;
    head.bytes += Buffer.byteLength(text);
    for (const event of logged) if (event.type.endsWith(".genesis")) head.genesis.add(event.type.slice(0, -".genesis".length));
    return logged;
  }

  /**
   * Replaces the stream's file with these genesis events (atomic: temp file, then rename), continuing
   * the seq. Everything before is dropped: each area restarts from its genesis.
   */
  async compact(stream: string, genesis: ReadonlyArray<{ area: string; at: string; state: unknown }>): Promise<void> {
    const head = await this.head(stream);
    const logged: LoggedEvent[] = genesis.map(({ area, at, state }, i) => ({ v: ENVELOPE_VERSION, stream, seq: head.seq + 1 + i, type: genesisType(area), at, data: { state } }));
    const text = logged.map((event) => `${JSON.stringify(event)}\n`).join("");
    const file = this.file(stream);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, text, "utf8");
      await rename(temp, file);
    } catch (error) {
      this.heads.delete(stream);
      await rm(temp, { force: true });
      throw error;
    }
    head.seq = logged.at(-1)?.seq ?? head.seq;
    head.bytes = Buffer.byteLength(text);
    head.genesis = new Set(genesis.map((entry) => entry.area));
  }

  /** Forgets the cached head: the next use reloads it from disk. */
  forget(stream: string): void {
    this.heads.delete(stream);
  }

  async remove(stream: string): Promise<void> {
    this.heads.delete(stream);
    await rm(this.file(stream), { force: true });
  }
}
