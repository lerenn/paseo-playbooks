/**
 * The Sidekick chat reads its timeline through a window: a small first page for a fast first paint, then
 * older pages when the reader scrolls back. Pure helpers (sizes, scroll maths), so they are tested without a host.
 */
import type { Item } from "./reduce";

/** Entries read when the chat opens: small, so the first paint mounts few items. */
export const FIRST_PAGE = 40;
/** Entries read each time the reader reaches the top. */
export const OLDER_PAGE = 40;
/** Entries re-read after a reconnect or a replaced timeline: wide enough to cover what was missed and overlap what is shown. */
export const RELOAD_PAGE = 200;
/** How close to the top (in pixels) the reader must scroll before older entries are read. */
export const NEAR_TOP_PX = 300;
/** How far from the bottom (in pixels) the reader still counts as following the end of the chat. */
export const STICK_PX = 40;

/** Whether the reader is at the bottom: new text then keeps the view at the end. */
export function isStuck(contentHeight: number, offsetY: number, viewportHeight: number): boolean {
  return contentHeight - (offsetY + viewportHeight) <= STICK_PX;
}

/** Whether older entries should be read now: near the top, some remain, none is being read. */
export function shouldLoadOlder(input: { offsetY: number; hasMore: boolean; loading: boolean }): boolean {
  return input.hasMore && !input.loading && input.offsetY <= NEAR_TOP_PX;
}

/** The offset that keeps the same text under the reader's eyes after entries were added above it. */
export function offsetAfterPrepend(previous: { height: number; offsetY: number }, nextHeight: number): number {
  return Math.max(0, previous.offsetY + (nextHeight - previous.height));
}

/** Whether `next` is `previous` with entries added above it (and nothing else moved): the view must not follow the end for it. */
export function isPrepend(previous: Item[], next: Item[]): boolean {
  const before = previous[0];
  const after = next[0];
  if (!before || !after || before.key === after.key) return false;
  return next.some((item) => item.key === before.key);
}

/** The sequence number of a key read from the timeline (`seq:12`), or null for a live item. */
export function seqOf(key: string): number | null {
  if (!key.startsWith("seq:")) return null;
  const seq = Number(key.slice(4));
  return Number.isFinite(seq) ? seq : null;
}
