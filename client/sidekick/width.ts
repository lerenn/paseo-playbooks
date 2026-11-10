export const COLUMN_WIDTH = 400;
export const MIN_COLUMN_WIDTH = 300;
export const MAX_COLUMN_WIDTH = 800;

/** Keeps a dragged column width between the minimum and the maximum. */
export function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}
