import { isDarkColor } from "./analytics-chart";
import { PAUSED_DARK, PAUSED_LIGHT } from "./tone-color";
import type { Theme } from "./theme";

/**
 * Colours that carry a meaning (state, severity, provider status) are fixed here, not taken from the host theme:
 * the theme's accent turns green in some themes, which made a running run look like a done one.
 * Only the light or dark variant follows the theme. Text, backgrounds, borders, buttons and links stay on theme colours.
 */
export type SemanticTone = "running" | "waiting" | "done" | "failed" | "paused";

export interface ToneColors {
  /** Text, icon, border or fill of the tone. */
  readonly color: string;
  /** Text or icon drawn on a fill of `color`. */
  readonly on: string;
}

/** Contrast of `color` on the usual panel surfaces (#101012 to #2c2c31): 5.0:1 or more. `on` is near black. */
export const SEMANTIC_DARK: Readonly<Record<SemanticTone, ToneColors>> = {
  running: { color: "#5b9dff", on: "#111111" },
  waiting: { color: "#f5a524", on: "#111111" },
  done: { color: "#3ecf8e", on: "#111111" },
  failed: { color: "#ff6b6b", on: "#111111" },
  paused: { color: PAUSED_DARK, on: "#111111" },
};

/** Contrast of `color` on the usual panel surfaces (#ffffff to #e0e0de): 3.8:1 or more (4.2 or more on the first three). `on` is white. */
export const SEMANTIC_LIGHT: Readonly<Record<SemanticTone, ToneColors>> = {
  running: { color: "#1d62d0", on: "#ffffff" },
  waiting: { color: "#b45309", on: "#ffffff" },
  done: { color: "#15803d", on: "#ffffff" },
  failed: { color: "#c92a2a", on: "#ffffff" },
  paused: { color: PAUSED_LIGHT, on: "#ffffff" },
};

/** The Theme type has no light/dark flag: it is read from the luminance of the card surface. */
export function isDarkTheme(theme: Theme): boolean {
  return isDarkColor(theme.colors.surface1);
}

export function semanticColors(theme: Theme, tone: SemanticTone): ToneColors {
  return (isDarkTheme(theme) ? SEMANTIC_DARK : SEMANTIC_LIGHT)[tone];
}

export function semanticColor(theme: Theme, tone: SemanticTone): string {
  return semanticColors(theme, tone).color;
}

/** Text or icon on a fill of the tone. */
export function semanticOn(theme: Theme, tone: SemanticTone): string {
  return semanticColors(theme, tone).on;
}

/** A stronger violet than `paused`, for the part of a quota bar above the allowed-so-far mark: apart from the grey usage and from the throttle bar's paused violet. */
export const OVER_DARK = "#7c4dff";
export const OVER_LIGHT = "#5b21b6";

export function overAllowanceColor(theme: Theme): string {
  return isDarkTheme(theme) ? OVER_DARK : OVER_LIGHT;
}
