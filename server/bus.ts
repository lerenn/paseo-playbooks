import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

/**
 * A small internal event bus. Producers register an event type (a dotted name, a payload schema
 * and how to describe it) and call `emit`. Agents subscribe by type glob and payload filter; a
 * `Notifier` delivers what matched. Nothing here knows about gates, runs or agents' tools.
 */

export const BusEventSchema = z.object({
  id: z.string(),
  /** Monotonic across restarts: an agent that was away asks for what came after the last one it saw. */
  seq: z.number().int().positive(),
  type: z.string(),
  at: z.string(),
  runId: z.string().nullable(),
  /** The producer that emitted it. */
  source: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type BusEvent = z.infer<typeof BusEventSchema>;

export interface EventTypeDef {
  /** Dotted name, e.g. "gate.opened". */
  type: string;
  description: string;
  /** Shape of the payload, validated on emit. Its keys are what a subscription filter may match. */
  payload: z.ZodObject<z.ZodRawShape>;
  /** One plain-text line for a message to an agent: what happened, and the tools to call. */
  line(event: BusEvent): string;
  /**
   * For events that fire once something has lasted long enough: the `olderThanMinutes` filter
   * picks the delay (default given here), and the payload's `thresholdMinutes` says which was
   * reached. The producer asks `thresholds(type)` to know which delays to watch.
   */
  threshold?: { default: number };
}

export const FilterValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const SubscriptionSchema = z.object({
  id: z.string(),
  /** The agent that created it; only it may remove it, and it is dropped when that agent is archived. */
  owner: z.string(),
  /** Where it is delivered: a Notifier kind and its target (for "agent", the agent id). */
  sink: z.object({ kind: z.string(), target: z.string() }),
  /** Type patterns: exact ("gate.opened") or globs ("gate.*", "*"). */
  types: z.array(z.string()).min(1),
  /** Payload fields that must equal these values; `olderThanMinutes` picks a threshold event's delay. */
  filter: z.record(z.string(), FilterValueSchema).default({}),
  createdAt: z.string(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** A delivery sink. "gone" tells the bus the target no longer exists: its subscriptions are dropped. */
export interface Notifier {
  deliver(subscription: Subscription, events: BusEvent[], text: string): Promise<"delivered" | "gone">;
}

export const MAX_SUBSCRIPTIONS = 20;
export const DEFAULT_CAPACITY = 500;
export const DEFAULT_DEBOUNCE_MS = 5000;

export class BusError extends Error {}

/** `*` matches any run of characters, dots included; everything else matches itself. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

export function matchesType(patterns: string[], type: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(type));
}

/** The text of a message: the events' lines, then how to catch up or stop. */
export function eventsMessage(lines: string[], lastSeq: number): string {
  return [
    `[playbooks] ${lines.length} event${lines.length === 1 ? "" : "s"} you subscribed to:`,
    ...lines,
    "",
    `list_events { since: ${lastSeq} } replays what comes after; unsubscribe_events stops these messages.`,
  ].join("\n");
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export interface EmitMeta {
  runId?: string | null;
  source: string;
  /** Agents that caused the event: they are not told about it, which would echo their own call back. */
  actors?: string[];
  at?: string;
}

export class EventBus {
  private readonly types = new Map<string, EventTypeDef>();
  private readonly notifiers = new Map<string, Notifier>();
  private log: BusEvent[] = [];
  private subscriptions: Subscription[] = [];
  private seq = 0;
  private loaded: Promise<void> | null = null;
  /** Events waiting out the debounce, per subscription id: delivery coalesces, producers do not. */
  private readonly queues = new Map<string, { events: BusEvent[]; since: number }>();
  private writing: Promise<void> = Promise.resolve();
  private flushing = false;

  constructor(
    private readonly files: { events: string; subscriptions: string },
    private readonly options: { capacity?: number; debounceMs?: number } = {},
  ) {}

  // ------------------------------------------------------------------ registry

  register(def: EventTypeDef): void {
    this.types.set(def.type, def);
  }

  registerNotifier(kind: string, notifier: Notifier): void {
    this.notifiers.set(kind, notifier);
  }

  typeNames(): string[] {
    return [...this.types.keys()].sort();
  }

  // ------------------------------------------------------------------ state

  private ready(): Promise<void> {
    this.loaded ??= (async () => {
      const events = z.array(BusEventSchema).safeParse(await readJson(this.files.events));
      if (events.success) {
        this.log = events.data;
        this.seq = Math.max(0, ...this.log.map((event) => event.seq));
      }
      const subs = z.array(SubscriptionSchema).safeParse(await readJson(this.files.subscriptions));
      if (subs.success) this.subscriptions = subs.data;
    })();
    return this.loaded;
  }

  private write(file: string, value: unknown): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        await writeFile(`${file}.tmp`, `${JSON.stringify(value)}\n`);
        await rename(`${file}.tmp`, file);
      } catch (error) {
        console.error("[playbooks] could not save events:", error instanceof Error ? error.message : error);
      }
    });
    return this.writing;
  }

  /** Resolves once what was written is on disk. */
  async close(): Promise<void> {
    await this.writing;
  }

  // ------------------------------------------------------------------ emit and route

  async emit(type: string, payload: Record<string, unknown>, meta: EmitMeta): Promise<BusEvent> {
    await this.ready();
    const def = this.types.get(type);
    if (!def) throw new BusError(`unknown event type "${type}"`);
    const parsed = def.payload.safeParse(payload);
    if (!parsed.success) throw new BusError(`bad payload for ${type}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    const event: BusEvent = { id: `evt-${this.seq + 1}`, seq: ++this.seq, type, at: meta.at ?? new Date().toISOString(), runId: meta.runId ?? null, source: meta.source, payload: parsed.data };
    this.log.push(event);
    const capacity = this.options.capacity ?? DEFAULT_CAPACITY;
    if (this.log.length > capacity) this.log = this.log.slice(-capacity);
    void this.write(this.files.events, this.log);
    for (const subscription of this.subscriptions) {
      if (!this.wants(subscription, event, def) || meta.actors?.includes(subscription.owner)) continue;
      const queue = this.queues.get(subscription.id) ?? { events: [], since: Date.parse(event.at) };
      queue.events.push(event);
      this.queues.set(subscription.id, queue);
    }
    return event;
  }

  private wants(subscription: Subscription, event: BusEvent, def: EventTypeDef): boolean {
    if (!matchesType(subscription.types, event.type)) return false;
    for (const [key, value] of Object.entries(subscription.filter)) {
      if (key === "olderThanMinutes") continue;
      if (event.payload[key] !== value) return false;
    }
    return !def.threshold || (subscription.filter.olderThanMinutes ?? def.threshold.default) === event.payload.thresholdMinutes;
  }

  /** The delays subscribers to a threshold type ask for, so its producer emits at each one. */
  async thresholds(type: string): Promise<number[]> {
    await this.ready();
    const def = this.types.get(type);
    if (!def?.threshold) return [];
    const wanted = this.subscriptions.filter((subscription) => matchesType(subscription.types, type)).map((subscription) => Number(subscription.filter.olderThanMinutes ?? def.threshold!.default));
    return [...new Set(wanted)].sort((a, b) => a - b);
  }

  // ------------------------------------------------------------------ delivery

  /** Sends each subscription's queued events as one message once its oldest is `debounceMs` old. */
  async flush(now = Date.now()): Promise<void> {
    await this.ready();
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [id, queue] of [...this.queues]) {
        if (Math.max(0, now - queue.since) < (this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)) continue;
        this.queues.delete(id);
        const subscription = this.subscriptions.find((candidate) => candidate.id === id);
        const notifier = subscription && this.notifiers.get(subscription.sink.kind);
        if (!subscription || !notifier) continue;
        const lines = queue.events.map((event) => this.types.get(event.type)?.line(event) ?? `- ${event.type} (${event.id})`);
        const outcome = await notifier.deliver(subscription, queue.events, eventsMessage(lines, queue.events.at(-1)!.seq)).catch((error: unknown) => {
          console.error(`[playbooks] could not deliver events to ${subscription.sink.kind} ${subscription.sink.target}:`, error instanceof Error ? error.message : error);
          return "delivered" as const;
        });
        if (outcome === "gone") await this.dropTarget(subscription.sink.kind, subscription.sink.target);
      }
    } finally {
      this.flushing = false;
    }
  }

  // ------------------------------------------------------------------ subscriptions

  /** Checks type patterns and filter keys against the registry; throws a BusError that says what is known. */
  private check(types: string[], filter: Record<string, string | number | boolean>): void {
    for (const pattern of types) {
      if (![...this.types.keys()].some((type) => globToRegExp(pattern).test(type))) throw new BusError(`no event type matches "${pattern}" (known: ${this.typeNames().join(", ")})`);
    }
    const chosen = [...this.types.values()].filter((def) => matchesType(types, def.type));
    const fields = new Set(chosen.flatMap((def) => Object.keys(def.payload.shape)));
    if (chosen.some((def) => def.threshold)) fields.add("olderThanMinutes");
    for (const key of Object.keys(filter)) {
      if (!fields.has(key)) throw new BusError(`filter "${key}" is not a field of ${types.join(", ")} (fields: ${[...fields].sort().join(", ")})`);
    }
  }

  async subscribe(owner: string, sink: { kind: string; target: string }, types: string[], filter: Record<string, string | number | boolean> = {}): Promise<Subscription> {
    await this.ready();
    if (!this.notifiers.has(sink.kind)) throw new BusError(`no notifier for "${sink.kind}"`);
    this.check(types, filter);
    if (this.subscriptions.filter((subscription) => subscription.owner === owner).length >= MAX_SUBSCRIPTIONS) throw new BusError(`you already hold ${MAX_SUBSCRIPTIONS} subscriptions: unsubscribe_events one first (see list_subscriptions)`);
    const subscription: Subscription = { id: `sub-${Math.random().toString(36).slice(2, 8)}`, owner, sink, types: [...new Set(types)], filter, createdAt: new Date().toISOString() };
    this.subscriptions.push(subscription);
    await this.write(this.files.subscriptions, this.subscriptions);
    return subscription;
  }

  async unsubscribe(owner: string, id: string): Promise<void> {
    await this.ready();
    const at = this.subscriptions.findIndex((subscription) => subscription.id === id && subscription.owner === owner);
    if (at < 0) throw new BusError(`you have no subscription "${id}" (see list_subscriptions)`);
    this.subscriptions.splice(at, 1);
    this.queues.delete(id);
    await this.write(this.files.subscriptions, this.subscriptions);
  }

  async list(owner: string): Promise<Subscription[]> {
    await this.ready();
    return this.subscriptions.filter((subscription) => subscription.owner === owner);
  }

  /** Drops every subscription owned by, or delivered to, this target (an archived or lost agent). */
  async dropOwner(owner: string): Promise<void> {
    await this.ready();
    await this.dropWhere((subscription) => subscription.owner === owner || subscription.sink.target === owner);
  }

  private async dropTarget(kind: string, target: string): Promise<void> {
    await this.dropWhere((subscription) => subscription.sink.kind === kind && subscription.sink.target === target);
  }

  private async dropWhere(match: (subscription: Subscription) => boolean): Promise<void> {
    const kept = this.subscriptions.filter((subscription) => !match(subscription));
    if (kept.length === this.subscriptions.length) return;
    for (const subscription of this.subscriptions) if (match(subscription)) this.queues.delete(subscription.id);
    this.subscriptions = kept;
    await this.write(this.files.subscriptions, this.subscriptions);
  }

  // ------------------------------------------------------------------ the recent log

  /** Events after `since` (a seq), oldest first; without `since`, the last `limit`. */
  async recent(query: { since?: number | undefined; types?: string[] | undefined; limit?: number | undefined } = {}): Promise<{ events: BusEvent[]; lastSeq: number; oldestSeq: number | null }> {
    await this.ready();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), this.options.capacity ?? DEFAULT_CAPACITY);
    let events = this.log.filter((event) => (query.since === undefined || event.seq > query.since) && (!query.types?.length || matchesType(query.types, event.type)));
    events = query.since === undefined ? events.slice(-limit) : events.slice(0, limit);
    return { events, lastSeq: this.seq, oldestSeq: this.log[0]?.seq ?? null };
  }
}
