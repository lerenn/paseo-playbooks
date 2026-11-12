import type { Run } from "../shared/types";

/**
 * The event core's vocabulary (ADR 2026-11-12-event-core). A domain event is a fact about a run
 * ("job X joined batch Y"), recorded by a mutator in the same place it changes the state. A
 * reducer turns an event back into the state change, with no other input. In stage 1 the mutators
 * still produce the state and the reducers are checked against them (parity); later stages let the
 * reducers produce it.
 */

/** What a mutator records: the fact, when, and the data a reducer needs to apply it. */
export interface DomainEvent {
  /** `<area>.<fact>`, e.g. "job.joined". */
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** The envelope an event has once appended to a run's log: one JSON object per line. */
export interface LoggedEvent extends DomainEvent {
  /** Envelope version; an event written by a newer plugin is skipped by an older one, never misread. */
  v: 1;
  /** The log it belongs to: the run id. */
  stream: string;
  /** 1, 2, 3 ... within the stream; never reused, never reordered. */
  seq: number;
}

export const ENVELOPE_VERSION = 1;

/** Applies one event to a run: the same change the mutator made. Must be deterministic and use only the event. */
export type Reducer = (run: Run, event: DomainEvent) => void;

/**
 * A slice of run state that is event-sourced: the reducers of its events, how to read and restore
 * its state (for genesis and parity), and the history entry types its events write.
 */
export interface Area {
  name: string;
  reducers: Readonly<Record<string, Reducer>>;
  /** The state this area owns, as plain data. */
  state(run: Run): unknown;
  /** Puts a state back (a genesis event). */
  restore(run: Run, state: unknown): void;
  /** History entry types the area's events write: parity compares those entries too. */
  historyTypes: ReadonlySet<string>;
}

export const genesisType = (area: string): string => `${area}.genesis`;

/** Appends a history entry the way the mutators' `log` does; reducers use it so history is derivable too. */
export function note(run: Run, at: string, type: string, stepId: string | null, detail: string): void {
  run.seq += 1;
  run.history.push({ seq: run.seq, at, type, stepId, detail });
  run.updatedAt = at;
}

// ------------------------------------------------------------------ recording

const pending = new WeakMap<object, DomainEvent[]>();

/**
 * Records an event on the run object a mutator is changing. The store takes them when the
 * mutation succeeds (`takeEvents`); on a run copy that is dropped (a dry run, a failed mutation)
 * they are garbage collected with it, so nothing is ever logged for a change that did not happen.
 */
export function record(run: Run, type: string, data: Record<string, unknown>, at: string): void {
  const list = pending.get(run) ?? [];
  list.push({ type, at, data: structuredClone(data) });
  pending.set(run, list);
}

export function takeEvents(run: Run): DomainEvent[] {
  const list = pending.get(run) ?? [];
  pending.delete(run);
  return list;
}

// ------------------------------------------------------------------ registry and replay

export function areaOfEvent(areas: readonly Area[], type: string): Area | undefined {
  return areas.find((area) => type === genesisType(area.name) || Object.hasOwn(area.reducers, type));
}

/** Applies events to a copy of `base`; throws when an event has no reducer (a type nobody registered). */
export function replay(areas: readonly Area[], base: Run, events: readonly DomainEvent[]): Run {
  const run = structuredClone(base);
  for (const event of events) applyEvent(areas, run, event);
  return run;
}

export function applyEvent(areas: readonly Area[], run: Run, event: DomainEvent): void {
  const area = areaOfEvent(areas, event.type);
  if (!area) throw new Error(`no reducer for event type "${event.type}"`);
  if (event.type === genesisType(area.name)) area.restore(run, event.data.state);
  else area.reducers[event.type]!(run, event);
}

// ------------------------------------------------------------------ parity

/** Sorted-key JSON, so two values with the same content compare equal whatever their key order. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
}

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (canonical(a) === canonical(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (found) return found;
    }
  } else if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return `${path}: mutator ${canonical(a)?.slice(0, 160)} / reducer ${canonical(b)?.slice(0, 160)}`;
}

function areaHistory(area: Area, run: Run, after: number) {
  return run.history.filter((entry) => entry.seq > after && area.historyTypes.has(entry.type)).map(({ at, type, stepId, detail }) => ({ at, type, stepId, detail }));
}

/**
 * Parity of one mutation: the state `after` the mutator produced, against what the reducers make of
 * `before` plus the recorded events. Compares each touched area's state and the history entries it
 * writes (without their `seq`, which other entries of the same mutation interleave). Returns the
 * differences, empty when the two agree.
 */
export function checkParity(areas: readonly Area[], before: Run, after: Run, events: readonly DomainEvent[]): string[] {
  const touched = new Set<Area>();
  for (const event of events) {
    const area = areaOfEvent(areas, event.type);
    if (area) touched.add(area);
  }
  let rebuilt: Run;
  try {
    rebuilt = replay(areas, before, events);
  } catch (error) {
    return [`replay failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems: string[] = [];
  for (const area of touched) {
    const state = firstDifference(area.state(after), area.state(rebuilt), area.name);
    if (state) problems.push(state);
    const history = firstDifference(areaHistory(area, after, before.seq), areaHistory(area, rebuilt, before.seq), `${area.name} history`);
    if (history) problems.push(history);
  }
  return problems;
}

/**
 * Parity of a whole log: the area states rebuilt from each area's latest genesis through the events
 * after it, against the snapshot. Only meaningful when the snapshot includes the whole log
 * (`run.eventSeq` equals the last seq); returns the differences.
 */
export function verifyLog(areas: readonly Area[], run: Run, events: readonly LoggedEvent[]): string[] {
  const problems: string[] = [];
  for (const area of areas) {
    const from = events.findLastIndex((event) => event.type === genesisType(area.name));
    if (from < 0) continue;
    const rebuilt = structuredClone(run);
    try {
      for (const event of events.slice(from)) if (areaOfEvent([area], event.type)) applyEvent([area], rebuilt, event);
    } catch (error) {
      problems.push(`${area.name}: replay failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const diff = firstDifference(area.state(run), area.state(rebuilt), area.name);
    if (diff) problems.push(diff);
  }
  return problems;
}
