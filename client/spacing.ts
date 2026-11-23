/**
 * Spacing and type scale of the Quota and Off hours tabs (the panel has no shared tokens, so these
 * are the one place the numbers live). Gaps grow with the level of the thing they separate.
 */
export const SPACE = {
  /** Between a bar and its text, and between lines of one block. */
  tight: 6,
  /** Between a window's name, its bar and its numbers; between sections of a row. */
  block: 10,
  /** Between the windows of a provider. */
  window: 16,
  /** Between providers, and between the header and the detail of an opened row. */
  provider: 24,
} as const;

/** Text sizes with a line height, for the secondary lines of the detail. */
export const TEXT = {
  body: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
} as const;

/** Readable width of the bars and detail text: they keep the full width on a narrow screen and stop here on a wide one, left-aligned. */
export const DETAIL_MAX_WIDTH = 560;
