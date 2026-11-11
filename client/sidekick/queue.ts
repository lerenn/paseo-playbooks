import type { Pending } from "./attach";

/** A message held until the Sidekick's turn ends (the daemon only knows steer and interrupt, so the queue lives in the UI). */
export interface QueuedMessage {
  text: string;
  attachments: Pending[];
}

/** Meta+Enter (Cmd on Mac) or Ctrl+Enter queues instead of sending now. */
export function isQueueKey(key: { key?: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): boolean {
  return key.key === "Enter" && (key.metaKey === true || key.ctrlKey === true) && key.shiftKey !== true;
}

/** What Meta+Enter does: send at once when the Sidekick is idle, else hold the message. */
export function queueAction(running: boolean): "send" | "queue" {
  return running ? "queue" : "send";
}

/** A queued message goes out once the chat is live and no turn runs. */
export function shouldFlush(queued: QueuedMessage | undefined, chat: { live: boolean; running: boolean; sending: boolean }): boolean {
  return queued !== undefined && chat.live && !chat.running && !chat.sending;
}

/** A second queued message joins the first (one pending line, one delivery). */
export function mergeQueued(current: QueuedMessage | undefined, next: QueuedMessage): QueuedMessage {
  if (!current) return next;
  return { text: [current.text, next.text].filter(Boolean).join("\n\n"), attachments: [...current.attachments, ...next.attachments] };
}
