/**
 * The Sidekick chat's state: a timeline of items built from the agent's timeline (a snapshot read with
 * `refetch`, then live events), the pending permission requests and whether a turn runs. Pure, so it is
 * tested without a host. Ideas from the reducer of paseo-bytheway (MIT), written for this plugin.
 */

import { markInstructions } from "./instructions";
import { seqOf } from "./window";

export interface PermissionRequest {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: unknown;
  /** What the host offers to remember ("allow always"): sent back as updatedPermissions. */
  suggestions?: Record<string, unknown>[];
}

export type Item =
  | { kind: "user"; key: string; text: string; instructions?: boolean }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | { kind: "tool"; key: string; callId: string; name: string; status: "running" | "completed" | "failed" | "canceled"; detail: Record<string, unknown> | null; error: string | null }
  | { kind: "notice"; key: string; level: "info" | "warning" | "error"; text: string };

/** Where the span stands: what is above the oldest entry read, and the page being read. */
export interface OlderState {
  /** The timeline's epoch the items come from: a page of another epoch is not merged. */
  epoch: string | null;
  /** Where to read the entries before the oldest one shown; null when none remain. */
  cursor: { epoch: string; seq: number } | null;
  hasMore: boolean;
  loading: boolean;
}

export interface ChatState {
  items: Item[];
  older: OlderState;
  nextSeq: number;
  running: boolean;
  /** Our own steer is in flight on a running turn: the cancel it causes is not a user stop. */
  steering: boolean;
  permissions: PermissionRequest[];
  connection: "connecting" | "live" | "error";
  error: string | null;
}

/** A timeline item as the daemon sends it (an entry of a refetch page, or the item of a live event). */
export interface RawItem {
  type: string;
  text?: string;
  messageId?: string;
  callId?: string;
  name?: string;
  status?: "running" | "completed" | "failed" | "canceled";
  detail?: Record<string, unknown>;
  error?: unknown;
  message?: string;
  level?: "info" | "warning" | "error";
}

export type ChatAction =
  | { type: "reset" }
  | { type: "refetch"; items: { key: string; item: RawItem }[]; span?: WindowInfo }
  | { type: "older_start" }
  | { type: "older_failed" }
  | { type: "older"; items: { key: string; item: RawItem }[]; /** The seq of the cursor the page was read from. */ from: number; span: WindowInfo }
  | { type: "event"; event: { type: string; item?: RawItem; request?: PermissionRequest; requestId?: string; error?: string; reason?: string } }
  | { type: "steer_sent" }
  | { type: "snapshot"; running: boolean; permissions: PermissionRequest[] }
  | { type: "permission_resolved"; requestId: string }
  | { type: "connection"; status: ChatState["connection"]; error?: string | null };

/** What a page says about where it sits in the timeline. */
export interface WindowInfo {
  epoch: string;
  startCursor: { epoch: string; seq: number } | null;
  hasOlder: boolean;
}

const noOlder = (): OlderState => ({ epoch: null, cursor: null, hasMore: false, loading: false });

export function initialState(): ChatState {
  return { items: [], older: noOlder(), nextSeq: 1, running: false, steering: false, permissions: [], connection: "connecting", error: null };
}

const errorText = (error: unknown): string | null => (error == null ? null : typeof error === "string" ? error : ((error as { message?: string }).message ?? JSON.stringify(error)));

function close(items: Item[]): Item[] {
  return items.some((item) => (item.kind === "assistant" || item.kind === "reasoning") && item.streaming)
    ? items.map((item) => ((item.kind === "assistant" || item.kind === "reasoning") && item.streaming ? { ...item, streaming: false } : item))
    : items;
}

/** One raw item as an Item, or null for the ones the chat does not show. `streaming` marks a live chunk. */
export function toItem(raw: RawItem, key: string, streaming: boolean): Item | null {
  switch (raw.type) {
    case "user_message":
      return /\S/.test(raw.text ?? "") ? { kind: "user", key, text: raw.text ?? "" } : null;
    case "assistant_message":
      return /\S/.test(raw.text ?? "") ? { kind: "assistant", key, text: raw.text ?? "", streaming } : null;
    case "reasoning":
      return /\S/.test(raw.text ?? "") ? { kind: "reasoning", key, text: raw.text ?? "", streaming } : null;
    case "tool_call":
      return { kind: "tool", key, callId: raw.callId ?? key, name: raw.name ?? "tool", status: raw.status ?? "running", detail: raw.detail ?? null, error: errorText(raw.error) };
    case "error":
      return { kind: "notice", key, level: "error", text: raw.message ?? "Error" };
    case "notification":
      return { kind: "notice", key, level: raw.level ?? "info", text: raw.message ?? "" };
    default:
      return null;
  }
}

function applyItem(state: ChatState, raw: RawItem): ChatState {
  const last = state.items[state.items.length - 1];
  // Live text chunks are deltas: they extend the message being streamed.
  if ((raw.type === "assistant_message" || raw.type === "reasoning") && /\S|\n/.test(raw.text ?? "")) {
    const kind = raw.type === "assistant_message" ? "assistant" : "reasoning";
    if (last && last.kind === kind && last.streaming) {
      const items = state.items.slice(0, -1);
      items.push({ ...last, text: last.text + (raw.text ?? "") });
      return { ...state, items };
    }
  }
  if (raw.type === "tool_call") {
    const index = state.items.findIndex((item) => item.kind === "tool" && item.callId === raw.callId);
    const existing = index >= 0 ? state.items[index] : undefined;
    const next = toItem(raw, existing?.key ?? `tool:${raw.callId}`, false);
    if (!next) return state;
    if (index >= 0) {
      const items = state.items.slice();
      items[index] = next;
      return { ...state, items: close(items) };
    }
  }
  const key = `live:${state.nextSeq}`;
  const item = toItem(raw, key, true);
  if (!item) return state;
  return { ...state, items: markInstructions([...close(state.items), item]), nextSeq: state.nextSeq + 1 };
}

/** Whether the page already shows this live item (a tool call by id, a text by its content). */
function inPage(item: Item, page: Item[]): boolean {
  if (item.kind === "tool") return page.some((entry) => entry.kind === "tool" && entry.callId === item.callId);
  const text = item.text.trim();
  return page.some((entry) => entry.kind === item.kind && "text" in entry && (entry.text.includes(text) || text.includes(entry.text.trim())));
}

/**
 * Nothing shown is ever removed: a page replaces the items, but it can miss ones the live events already
 * showed (tool calls, a notice, a message not yet in the page). Those stay, each placed after the item that
 * preceded it.
 */
function keepLiveItems(live: Item[], page: Item[], skip: (item: Item) => boolean = () => false): Item[] {
  const out = page.slice();
  live.forEach((item, index) => {
    if (skip(item) || inPage(item, page)) return;
    let after = -1;
    for (let back = index - 1; back >= 0 && after < 0; back--) {
      const prev = live[back]!;
      after = out.findIndex((entry) => entry.key === prev.key || (entry.kind === prev.kind && inPage(prev, [entry])));
    }
    out.splice(after + 1, 0, item);
  });
  return out;
}

/** A tool call appears once per status change in a page: keep the last of each. */
function dedupeTools(items: Item[]): Item[] {
  const seen = new Map<string, number>();
  const out: Item[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const at = seen.get(item.callId);
      if (at !== undefined) {
        out[at] = item;
        continue;
      }
      seen.set(item.callId, out.length);
    }
    out.push(item);
  }
  return out;
}

const sameItem = (a: Item, b: Item): boolean => {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "user":
      return a.text === (b as typeof a).text && a.instructions === (b as typeof a).instructions;
    case "assistant":
    case "reasoning":
      return a.text === (b as typeof a).text && a.streaming === (b as typeof a).streaming;
    case "notice":
      return a.level === (b as typeof a).level && a.text === (b as typeof a).text;
    case "tool": {
      const other = b as typeof a;
      return a.callId === other.callId && a.name === other.name && a.status === other.status && a.error === other.error && JSON.stringify(a.detail) === JSON.stringify(other.detail);
    }
  }
};

/** An item that did not change keeps its identity, so a memoized view of it does not render again. */
function reuse(previous: Item[], next: Item[]): Item[] {
  const byKey = new Map(previous.map((item) => [item.key, item]));
  return next.map((item) => {
    const before = byKey.get(item.key);
    return before && sameItem(before, item) ? before : item;
  });
}

export function reduce(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialState();
    case "refetch": {
      const page = dedupeTools(action.items.flatMap(({ key, item }) => {
        const converted = toItem(item, key, false);
        return converted ? [converted] : [];
      }));
      const span = action.span;
      const pageMin = Math.min(...page.map((item) => seqOf(item.key) ?? Infinity));
      // Older pages already read stay when the page overlaps what is shown (nothing was missed in between).
      const sameEpoch = !span || state.older.epoch === null || state.older.epoch === span.epoch;
      const overlaps = state.items.some((item) => {
        const seq = seqOf(item.key);
        return seq !== null && seq >= pageMin;
      });
      const keepOlder = sameEpoch && overlaps && state.older.epoch !== null;
      const older = keepOlder ? state.items.filter((item) => (seqOf(item.key) ?? Infinity) < pageMin) : [];
      // The page is the truth for every entry it covers; only what the live events showed (no sequence number) is kept besides.
      const merged = [...older, ...reuse(state.items, keepLiveItems(state.items, page, span ? (item) => seqOf(item.key) !== null : undefined))];
      const nextOlder: OlderState = !span
        ? state.older
        : keepOlder && older.length > 0
          ? { ...state.older, loading: false }
          : { epoch: span.epoch, cursor: span.hasOlder ? span.startCursor : null, hasMore: span.hasOlder && span.startCursor !== null, loading: false };
      return { ...state, items: markInstructions(merged), older: nextOlder };
    }
    case "older_start":
      return state.older.loading || !state.older.hasMore ? state : { ...state, older: { ...state.older, loading: true } };
    case "older_failed":
      return state.older.loading ? { ...state, older: { ...state.older, loading: false } } : state;
    case "older": {
      // A page of another epoch, or read from a cursor that is no longer the oldest, is dropped: never merged twice.
      if (state.older.epoch !== action.span.epoch || state.older.cursor?.seq !== action.from) return { ...state, older: { ...state.older, loading: false } };
      const keys = new Set(state.items.map((item) => item.key));
      const calls = new Set(state.items.flatMap((item) => (item.kind === "tool" ? [item.callId] : [])));
      const fresh = dedupeTools(
        action.items.flatMap(({ key, item }) => {
          const converted = keys.has(key) ? null : toItem(item, key, false);
          return converted ? [converted] : [];
        }),
      ).filter((item) => item.kind !== "tool" || !calls.has(item.callId));
      return {
        ...state,
        items: markInstructions([...fresh, ...state.items]),
        older: { epoch: action.span.epoch, cursor: action.span.hasOlder ? action.span.startCursor : null, hasMore: action.span.hasOlder && action.span.startCursor !== null, loading: false },
      };
    }
    case "event": {
      const event = action.event;
      switch (event.type) {
        case "turn_started":
          return { ...state, running: true, steering: false };
        case "turn_completed":
          return { ...state, running: false, items: close(state.items) };
        case "turn_failed":
          return { ...state, running: false, items: [...close(state.items), { kind: "notice", key: `live:${state.nextSeq}`, level: "error", text: event.error ?? "The turn failed" }], nextSeq: state.nextSeq + 1 };
        case "turn_canceled":
          // A steer cancels the turn it joins and starts the next one: that is not a stop.
          if (state.steering) return { ...state, running: false, steering: false, items: close(state.items) };
          return { ...state, running: false, items: [...close(state.items), { kind: "notice", key: `live:${state.nextSeq}`, level: "info", text: "Stopped" }], nextSeq: state.nextSeq + 1 };
        case "timeline":
          return event.item ? applyItem(state, event.item) : state;
        case "permission_requested":
          return event.request ? { ...state, permissions: [...state.permissions.filter((entry) => entry.id !== event.request!.id), event.request] } : state;
        case "permission_resolved":
          return { ...state, permissions: state.permissions.filter((entry) => entry.id !== event.requestId) };
        default:
          return state;
      }
    }
    case "steer_sent":
      return state.running ? { ...state, steering: true } : state;
    case "snapshot":
      return { ...state, running: action.running, permissions: action.permissions };
    case "permission_resolved":
      return { ...state, permissions: state.permissions.filter((entry) => entry.id !== action.requestId) };
    case "connection":
      return { ...state, connection: action.status, error: action.error ?? null };
  }
}
