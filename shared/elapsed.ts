import { formatSlowDuration } from "./slow";

/**
 * The live "running for" text of a step's current attempt: `<1s`, `45s`, `12m`, `1h05m` (the slow-step
 * format, so a non-zero duration is never `0s`). Null when the attempt has no readable start; a start in
 * the future (clock skew) counts as just started.
 */
export function runningFor(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const elapsed = Math.max(0, now - start);
  return elapsed === 0 ? "<1s" : formatSlowDuration(elapsed);
}
