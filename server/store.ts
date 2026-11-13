import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { repairRun } from "./engine";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pluginDataDir } from "./data-dir";
import { upcastRunNames } from "../shared/legacy-names";
import { RunSchema, type Run } from "../shared/types";
import { DEFAULT_EVENT_CORE, type EventCoreConfig } from "./config";
import { areaOfEvent, checkParity, genesisType, takeEvents, verifyLog, type Area, type DomainEvent } from "./event-core";
import { DEFAULT_COMPACT_BYTES, EventLog, LOG_SUFFIX } from "./event-log";
import { jobsArea } from "./job-events";

/** The event-sourced areas (ADR 2026-11-12-event-core): one entry per migrated slice of run state. */
export const EVENT_AREAS: readonly Area[] = [jobsArea];

export interface StoreOptions {
  /** `event_core` of the user config; tests may set `parity: "throw"` (or env `PLAYBOOKS_EVENT_PARITY=throw`). */
  eventCore?: Partial<Omit<EventCoreConfig, "parity">> & { parity?: EventCoreConfig["parity"] | "throw" };
  /** A stream above this many bytes is compacted at its next append. */
  compactBytes?: number;
}

/** Called after a mutation was written, with the run as it is now and the events the mutation recorded. */
export type EventListener = (run: Run, events: readonly DomainEvent[]) => void;

/** `<plugin data dir>/runs` (data-dir.ts), outside the plugins folder Paseo manages. */
export function defaultRunsDir(): string {
  return path.join(pluginDataDir(), "runs");
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
  readonly log: EventLog;
  private readonly settings: { log: boolean; parity: "warn" | "off" | "throw"; compactBytes: number };
  private readonly listeners: EventListener[] = [];

  constructor(readonly dir: string, options: StoreOptions = {}) {
    this.log = new EventLog(dir);
    const parity = options.eventCore?.parity ?? (process.env.PLAYBOOKS_EVENT_PARITY === "throw" ? "throw" : DEFAULT_EVENT_CORE.parity);
    this.settings = { log: options.eventCore?.log ?? DEFAULT_EVENT_CORE.log, parity, compactBytes: options.compactBytes ?? DEFAULT_COMPACT_BYTES };
  }

  /** Applies the `event_core` config; call before `init`. */
  configure(eventCore: NonNullable<StoreOptions["eventCore"]>): void {
    this.settings.log = eventCore.log ?? this.settings.log;
    if (eventCore.parity) this.settings.parity = eventCore.parity;
  }

  /** Listens to the events committed mutations record (in-process: the first of the internal wake-ups, ADR 2026-11-12-internal-wakeups). A listener's failure never fails the mutation. */
  onEvents(listener: EventListener): void {
    this.listeners.push(listener);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = RunSchema.parse(upcastRunNames(JSON.parse(await readFile(path.join(this.dir, name), "utf8"))));
        const added = repairRun(run);
        if (added.length > 0) console.warn(`[playbooks] ${run.id}: added the missing state of ${added.length} step(s): ${added.slice(0, 5).join(", ")}${added.length > 5 ? ", ..." : ""}`);
        this.runs.set(run.id, run);
      } catch (error) {
        console.error(`[playbooks] skipping unreadable run file ${name}:`, (error as Error).message);
      }
    }
    if (this.settings.log && this.settings.parity !== "off") await this.verifyLogs();
  }

  /** Parity at start: each run's log rebuilt from its latest genesis, against its snapshot. A log the snapshot is out of step with is left for the next append to re-baseline. */
  private async verifyLogs(): Promise<void> {
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(LOG_SUFFIX)) continue;
      const run = this.runs.get(name.slice(0, -LOG_SUFFIX.length));
      if (!run) continue;
      try {
        const { events, torn, skipped } = await this.log.read(run.id);
        if (torn || skipped) console.warn(`[playbooks] event log of ${run.id}: ${torn ? "a torn last line was dropped" : ""}${skipped ? ` ${skipped} unreadable line(s) skipped` : ""}`);
        if ((events.at(-1)?.seq ?? 0) !== run.eventSeq) continue;
        for (const problem of verifyLog(EVENT_AREAS, run, events)) console.warn(`[playbooks] event log parity (${run.id}): ${problem}`);
      } catch (error) {
        console.error(`[playbooks] could not verify the event log of ${run.id}:`, (error as Error).message);
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
      repairRun(working);
      const result = await fn(working);
      const events = takeEvents(working);
      // A mutation that changed nothing (a tick with nothing to do) writes nothing: same file, same snapshot.
      if (events.length === 0 && isDeepStrictEqual(run, working)) return result;
      if (events.length > 0) await this.commit(run, working, events);
      await this.write(working);
      this.runs.set(id, working);
      if (events.length > 0) this.notify(working, events);
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

  /**
   * Stage 1 of the event core: the mutator produced `after`; the events it recorded are checked against
   * it (parity) and appended to the run's log before the snapshot is written. The log never decides
   * anything yet, so a failure here is reported and the mutation goes on (only parity `throw`, for tests, fails it).
   */
  private async commit(before: Run, after: Run, events: DomainEvent[]): Promise<void> {
    if (!this.settings.log) return;
    if (this.settings.parity !== "off") {
      const problems = checkParity(EVENT_AREAS, before, after, events);
      if (problems.length > 0) {
        const text = `event parity mismatch in run ${after.id} (${events.map((event) => event.type).join(", ")}): ${problems.join(" | ")}`;
        if (this.settings.parity === "throw") throw new Error(text);
        console.warn(`[playbooks] ${text}`);
      }
    }
    if (this.closed) return;
    try {
      const head = await this.log.head(after.id);
      // The snapshot and the log disagree (a crash between the two writes, a downgrade): start every area over from a genesis.
      if (head.seq !== before.eventSeq) head.genesis.clear();
      const lines: DomainEvent[] = [];
      for (const area of EVENT_AREAS) {
        if (head.genesis.has(area.name) || !events.some((event) => areaOfEvent(EVENT_AREAS, event.type) === area)) continue;
        lines.push({ type: genesisType(area.name), at: events[0]!.at, data: { state: structuredClone(area.state(before)) } });
      }
      const logged = await this.log.append(after.id, [...lines, ...events]);
      after.eventSeq = logged.at(-1)!.seq;
      if ((await this.log.head(after.id)).bytes > this.settings.compactBytes) {
        await this.log.compact(
          after.id,
          EVENT_AREAS.filter((area) => (head.genesis.has(area.name))).map((area) => ({ area: area.name, at: events.at(-1)!.at, state: structuredClone(area.state(after)) })),
        );
        after.eventSeq = (await this.log.head(after.id)).seq;
      }
    } catch (error) {
      this.log.forget(after.id);
      console.error(`[playbooks] could not append to the event log of ${after.id} (state is unaffected):`, error instanceof Error ? error.message : error);
    }
  }

  private notify(run: Run, events: readonly DomainEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(run, events);
      } catch (error) {
        console.error("[playbooks] event listener failed:", error instanceof Error ? error.message : error);
      }
    }
  }

  async delete(id: string): Promise<void> {
    await (this.queues.get(id) ?? Promise.resolve());
    this.runs.delete(id);
    this.queues.delete(id);
    await rm(path.join(this.dir, `${id}.json`), { force: true });
    await this.log.remove(id);
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
    const done = writeFile(temp, `${JSON.stringify(run)}\n`, "utf8").then(() => rename(temp, file));
    this.writing.add(done);
    try {
      await done;
    } finally {
      this.writing.delete(done);
    }
  }
}
