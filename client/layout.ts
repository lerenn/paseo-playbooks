/** Width of a step label above the line; the line is inset by half of it so end labels fit. */
export const LABEL_WIDTH = 96;
/** Rough width of a step label at 11 px, for choosing the layout before anything is measured. */
const CHAR_WIDTH = 6.4;
const LABEL_GAP = 6;
export const ROW_HEIGHT = 15;

/**
 * How the step labels fit over a line `width` px wide: on one row when the longest fits between
 * two ticks, else alternating over two rows (each label gets two gaps); a label still too long
 * is cut with an ellipsis. `labelWidth` is the box each label is centred in.
 */
export function labelLayout(width: number, labels: readonly string[]): { rows: 1 | 2; labelWidth: number } {
  const spacing = labels.length > 1 ? width / (labels.length - 1) : width;
  const needed = Math.max(0, ...labels.map((label) => label.length)) * CHAR_WIDTH + LABEL_GAP;
  if (spacing >= needed) return { rows: 1, labelWidth: Math.min(LABEL_WIDTH, Math.max(needed, spacing - LABEL_GAP)) };
  return { rows: 2, labelWidth: Math.max(24, Math.min(LABEL_WIDTH, needed, 2 * spacing - LABEL_GAP)) };
}
