/** An entry of an agent's timeline as the daemon sends it; only the fields the readable form needs. */
export interface TimelineEntry {
  seqStart?: number;
  item?: { type?: string; text?: string; name?: string; status?: string; error?: unknown; detail?: Record<string, unknown>; message?: string };
}

export interface ConversationOptions {
  /** Keep the agent's reasoning (default: left out, it is long and rarely what the reader needs). */
  includeReasoning: boolean;
  /** Keep tool calls with a clipped input (default: one line each, name and status). */
  includeToolDetail: boolean;
  /** Characters kept per message or detail. */
  maxChars: number;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return error === undefined || error === null ? "" : JSON.stringify(error);
}

/** One timeline entry as a line of plain text, or null when it is left out. */
export function conversationLine(entry: TimelineEntry, options: ConversationOptions): string | null {
  const item = entry.item;
  if (!item || typeof item.type !== "string") return null;
  switch (item.type) {
    case "user_message":
      return item.text ? `user: ${clip(item.text, options.maxChars)}` : null;
    case "assistant_message":
      return item.text ? `assistant: ${clip(item.text, options.maxChars)}` : null;
    case "reasoning":
      return options.includeReasoning && item.text ? `thought: ${clip(item.text, options.maxChars)}` : null;
    case "tool_call": {
      const failure = item.status === "failed" ? ` — ${clip(errorText(item.error) || "failed", 300)}` : "";
      const detail = options.includeToolDetail && item.detail ? `\n  ${clip(JSON.stringify(item.detail), options.maxChars)}` : "";
      return `tool: ${item.name ?? "?"} (${item.status ?? "?"})${failure}${detail}`;
    }
    case "error":
      return `error: ${clip(item.message ?? errorText(item.error), 600)}`;
    default:
      return null;
  }
}

/** A page of an agent's timeline as text, oldest first. Streaming deltas of one message arrive as separate entries and are merged. */
export function conversationText(entries: ReadonlyArray<TimelineEntry>, options: ConversationOptions): string {
  const lines: string[] = [];
  let previous: { type: string; text: string } | null = null;
  const flush = () => {
    if (!previous) return;
    const line = conversationLine({ item: previous }, options);
    if (line) lines.push(line);
    previous = null;
  };
  for (const entry of entries) {
    const item = entry.item;
    if (item && (item.type === "assistant_message" || item.type === "reasoning" || item.type === "user_message") && typeof item.text === "string") {
      if (previous && previous.type === item.type) previous.text += item.text;
      else {
        flush();
        previous = { type: item.type, text: item.text };
      }
      continue;
    }
    flush();
    const line = conversationLine(entry, options);
    if (line) lines.push(line);
  }
  flush();
  return lines.join("\n");
}
