/**
 * The Sidekick chat's state: a timeline of items built from the agent's timeline (a snapshot read with
 * `refetch`, then live events), the pending permission requests and whether a turn runs. Pure, so it is
 * tested without a host. Ideas from the reducer of paseo-bytheway (MIT), written for this plugin.
 */

export interface PermissionRequest {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: unknown;
}

export type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | { kind: "tool"; key: string; callId: string; name: string; status: "running" | "completed" | "failed" | "canceled"; detail: Record<string, unknown> | null; error: string | null }
  | { kind: "notice"; key: string; level: "info" | "warning" | "error"; text: string };

export interface ChatState {
  items: Item[];
  nextSeq: number;
  running: boolean;
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
  | { type: "refetch"; items: { key: string; item: RawItem }[] }
  | { type: "event"; event: { type: string; item?: RawItem; request?: PermissionRequest; requestId?: string; error?: string; reason?: string } }
  | { type: "snapshot"; running: boolean; permissions: PermissionRequest[] }
  | { type: "permission_resolved"; requestId: string }
  | { type: "connection"; status: ChatState["connection"]; error?: string | null };

export function initialState(): ChatState {
  return { items: [], nextSeq: 1, running: false, permissions: [], connection: "connecting", error: null };
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
  return { ...state, items: [...close(state.items), item], nextSeq: state.nextSeq + 1 };
}

export function reduce(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialState();
    case "refetch": {
      const items = action.items.flatMap(({ key, item }) => {
        const converted = toItem(item, key, false);
        return converted ? [converted] : [];
      });
      // A tool call appears once per status change in a page: keep the last of each.
      const seen = new Map<string, number>();
      const deduped: Item[] = [];
      for (const item of items) {
        if (item.kind === "tool") {
          const at = seen.get(item.callId);
          if (at !== undefined) {
            deduped[at] = item;
            continue;
          }
          seen.set(item.callId, deduped.length);
        }
        deduped.push(item);
      }
      return { ...state, items: deduped };
    }
    case "event": {
      const event = action.event;
      switch (event.type) {
        case "turn_started":
          return { ...state, running: true };
        case "turn_completed":
          return { ...state, running: false, items: close(state.items) };
        case "turn_failed":
          return { ...state, running: false, items: [...close(state.items), { kind: "notice", key: `live:${state.nextSeq}`, level: "error", text: event.error ?? "The turn failed" }], nextSeq: state.nextSeq + 1 };
        case "turn_canceled":
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
    case "snapshot":
      return { ...state, running: action.running, permissions: action.permissions };
    case "permission_resolved":
      return { ...state, permissions: state.permissions.filter((entry) => entry.id !== action.requestId) };
    case "connection":
      return { ...state, connection: action.status, error: action.error ?? null };
  }
}
