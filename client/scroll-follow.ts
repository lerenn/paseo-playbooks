/**
 * Scroll-follow rules of a chat: when the "scroll to bottom" shortcut shows, and how many new messages it counts.
 * Pure helpers (no host, no timers), so they are tested on their own.
 */
import type { Item } from "./sidekick/reduce";

/** The shortcut shows once the reader is further than this from the end (pixels)… */
export const AWAY_MIN_PX = 80;
/** …or further than this share of the visible height, whichever is larger. */
export const AWAY_VIEWPORT_SHARE = 1 / 3;
/** Once shown, the shortcut stays until the reader is this much closer than the show threshold (pixels): no flicker at the edge. */
export const HYSTERESIS_PX = 24;
/** The badge stops counting here and reads "9+". */
export const BADGE_CAP = 9;

/** How far from the end (pixels) the reader must be for the shortcut to appear. */
export function awayThreshold(viewportHeight: number): number {
  return Math.max(AWAY_MIN_PX, viewportHeight * AWAY_VIEWPORT_SHARE);
}

/** Whether the "scroll to bottom" shortcut shows, given whether it shows now (the hysteresis). `stickPx` is the follow distance: never hide above it. */
export function scrollButtonVisible(input: { shown: boolean; contentHeight: number; offsetY: number; viewportHeight: number; stickPx: number }): boolean {
  const distance = input.contentHeight - (input.offsetY + input.viewportHeight);
  const show = awayThreshold(input.viewportHeight);
  if (!input.shown) return distance > show;
  return distance > Math.max(input.stickPx, show - HYSTERESIS_PX);
}

/** The last entry the reader saw before leaving the bottom, and how big it was. */
export interface LeftAt {
  key: string;
  signature: string;
}

/** What counts as a message to read (tool calls and reasoning are not). */
function countable(item: Item): boolean {
  return item.kind === "assistant" || item.kind === "user" || item.kind === "notice";
}

/** Changes whenever an entry's content grows: the length of its text. */
function signatureOf(item: Item): string {
  return "text" in item ? String(item.text.length) : item.kind;
}

/** Remembers where the reader left the bottom; null when the chat is empty. */
export function leftAt(items: Item[]): LeftAt | null {
  const last = items[items.length - 1];
  return last ? { key: last.key, signature: signatureOf(last) } : null;
}

/**
 * New messages since the reader left the bottom. Entries after the remembered one count each; the remembered one counts once more if it
 * grew (a streaming reply is one unread, not one per token). Older entries added above never count. Unknown anchor (timeline replaced): 0.
 */
export function unreadSince(left: LeftAt | null, items: Item[]): number {
  if (!left) return 0;
  const at = items.findIndex((item) => item.key === left.key);
  if (at < 0) return 0;
  const anchor = items[at]!;
  const grew = countable(anchor) && signatureOf(anchor) !== left.signature ? 1 : 0;
  return grew + items.slice(at + 1).filter(countable).length;
}

/** The badge text: the count, capped ("9+"). */
export function badgeLabel(count: number): string {
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count);
}
