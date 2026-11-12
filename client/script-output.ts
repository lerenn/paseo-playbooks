import type { ScriptOutput } from "../shared/types";

/** How often the step sheet asks for a script's live output. */
export const SCRIPT_OUTPUT_POLL_MS = 2000;

export interface ScriptActivity {
  kind: "running" | "waiting" | "idle";
  /** What the sheet says: "Running now · 12 s", "Waiting · next check in ~30 s". */
  text: string;
}

/** Seconds as people say them: 45 s, 2 min 5 s, 1 h 3 min. */
export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes} min ${total % 60} s` : `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 60)} h`;
}

/** What started a check, as the sheet says it: "first run", "poll", "woken by job.settled" (stored as "first", "poll", "event:<type>"). */
export function triggerLabel(trigger: string | null | undefined): string {
  if (!trigger) return "";
  if (trigger === "first") return "first run";
  if (trigger.startsWith("event:")) return `woken by ${trigger.slice(6)}`;
  return trigger;
}

/** Whether a script step has a check running now, or waits for its next one. `stepRunning`: the step's status is "running". */
export function scriptActivity(output: ScriptOutput | undefined, nextCheckAt: string | null | undefined, stepRunning: boolean, now: number): ScriptActivity {
  if (!stepRunning) return { kind: "idle", text: "" };
  if (output?.running && output.since) return { kind: "running", text: `Running now · ${formatSeconds((now - Date.parse(output.since)) / 1000)}${output.trigger ? ` · ${triggerLabel(output.trigger)}` : ""}` };
  if (nextCheckAt) {
    const seconds = (Date.parse(nextCheckAt) - now) / 1000;
    return { kind: "waiting", text: seconds > 1 ? `Waiting · next check in ~${formatSeconds(seconds)}` : "Waiting · next check starting" };
  }
  // No live buffer (the daemon restarted) and no scheduled check: do not claim either.
  return output?.running ? { kind: "running", text: "Running now" } : { kind: "waiting", text: "Waiting for the next check" };
}

/** One ended check as a heading: "Check 3 · not yet · exit 75 · 14:02:11". */
export function checkHeading(check: ScriptOutput["checks"][number]): string {
  const outcome = check.outcome === "not_yet" ? "not yet" : check.outcome;
  const exit = check.exitCode === null ? "" : ` · exit ${check.exitCode}`;
  const why = check.trigger ? ` · ${triggerLabel(check.trigger)}` : "";
  return `Check ${check.n} · ${outcome}${exit}${why} · ${new Date(check.endedAt).toLocaleTimeString()}`;
}

/** The last `max` lines of a tail, so a long one does not fill the sheet. */
export function lastLines(text: string, max: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.length > max ? lines.slice(-max).join("\n") : lines.join("\n");
}
