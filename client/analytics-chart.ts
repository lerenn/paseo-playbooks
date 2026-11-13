/** Pure helpers of the Analytics charts: number and date labels, axis ticks, colours. */

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/** Categorical slots 1-5 (blue, orange, aqua, yellow, magenta), validated for the light and the dark surface. */
export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"] as const;
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"] as const;

export function seriesColor(index: number, dark: boolean): string {
  const palette = dark ? SERIES_DARK : SERIES_LIGHT;
  return palette[index % palette.length]!;
}

/** True when a `#rgb` / `#rrggbb` colour is dark; false for anything else (an unknown format reads as light). */
export function isDarkColor(color: string): boolean {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return false;
  let hex = match[1]!;
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255 < 0.5;
}

/** A round axis top and step covering `peak` in about `count` steps: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceAxis(peak: number, count = 3): { top: number; step: number } {
  if (!(peak > 0)) return { top: 1, step: 1 };
  const raw = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const factor = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const step = factor * magnitude;
  return { top: Math.ceil(peak / step - 1e-9) * step, step };
}

/** The values of the gridlines, 0 up to the axis top. */
export function axisTicks(peak: number, count = 3): number[] {
  const { top, step } = niceAxis(peak, count);
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 1000; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return ticks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-13" -> "Nov 13". Anything else comes back as it is. */
export function shortDate(day: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[2])}` : day;
}

/** Which days get a date label: the first, the middle and the last (fewer when there are fewer days). */
export function labelIndexes(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  if (count === 2) return [0, 1];
  return [0, Math.floor((count - 1) / 2), count - 1];
}
