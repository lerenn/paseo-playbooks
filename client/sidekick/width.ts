export const COLUMN_WIDTH = 400;
export const MIN_COLUMN_WIDTH = 300;

/** Keeps a dragged column width above the minimum; there is no maximum. */
export function clampColumnWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.round(width));
}
