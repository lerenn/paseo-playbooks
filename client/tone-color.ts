import { isDarkColor } from "./analytics-chart";
import type { LaneTone } from "./lane-tone";

/** Violet of a paused run: the host theme has none, so one per surface (contrast on its surface: about 7:1 dark, 5.7:1 light). */
export const PAUSED_DARK = "#a78bfa";
export const PAUSED_LIGHT = "#7c3aed";

export function pausedColor(surface: string): string {
  return isDarkColor(surface) ? PAUSED_DARK : PAUSED_LIGHT;
}

/** Order of tones under "Status": what needs a look first. Paused sits right after running, before the ended runs. */
export const TONE_RANK: Record<LaneTone, number> = { waiting: 0, running: 1, paused: 2, failed: 3, done: 4, seen: 5 };
