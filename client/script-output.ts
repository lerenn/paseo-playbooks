import type { ScriptOutput } from "../shared/types";
import { detailEn } from "./i18n-detail";
import type { Tr } from "./tr";

/** How often the step sheet asks for a script's live output. */
export const SCRIPT_OUTPUT_POLL_MS = 2000;

type ScriptKey = `detail.script.${keyof typeof detailEn.script}`;

/** The panel's `t`, narrowed to the keys these helpers use. The full `t` from `useTranslation(messages)` fits. */
export type ScriptT = Tr;

/** English, for a caller that does not pass `t` yet (and the unit tests). */
const english: ScriptT = (key: ScriptKey, options: Record<string, string | number> = {}) => {
  const text = detailEn.script[key.slice("detail.script.".length) as keyof typeof detailEn.script];
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));
};

export interface ScriptActivity {
  kind: "running" | "waiting" | "idle";
  /** What the sheet says: "Running now · 12 s", "Waiting · next check in ~30 s". */
  text: string;
}

/** Seconds as people say them: 45 s, 2 min 5 s, 1 h 3 min. */
export function formatSeconds(seconds: number, t: ScriptT = english): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return t("detail.script.seconds", { n: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? t("detail.script.minutesSeconds", { minutes, seconds: total % 60 }) : t("detail.script.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? t("detail.script.hoursMinutes", { hours, minutes: minutes % 60 }) : t("detail.script.hours", { hours });
}

/** What started a check, as the sheet says it: "first run", "poll", "woken by job.settled" (stored as "first", "poll", "event:<type>"). */
export function triggerLabel(trigger: string | null | undefined, t: ScriptT = english): string {
  if (!trigger) return "";
  if (trigger === "first") return t("detail.script.firstRun");
  if (trigger.startsWith("event:")) return t("detail.script.wokenBy", { event: trigger.slice(6) });
  return trigger;
}

/** Whether a script step has a check running now, or waits for its next one. `stepRunning`: the step's status is "running". */
export function scriptActivity(output: ScriptOutput | undefined, nextCheckAt: string | null | undefined, stepRunning: boolean, now: number, t: ScriptT = english): ScriptActivity {
  if (!stepRunning) return { kind: "idle", text: "" };
  if (output?.running && output.since) {
    const running = t("detail.script.runningFor", { duration: formatSeconds((now - Date.parse(output.since)) / 1000, t) });
    return { kind: "running", text: output.trigger ? `${running} · ${triggerLabel(output.trigger, t)}` : running };
  }
  if (nextCheckAt) {
    const seconds = (Date.parse(nextCheckAt) - now) / 1000;
    return { kind: "waiting", text: seconds > 1 ? t("detail.script.waitingIn", { duration: formatSeconds(seconds, t) }) : t("detail.script.waitingStarting") };
  }
  // No live buffer (the daemon restarted) and no scheduled check: do not claim either.
  return output?.running ? { kind: "running", text: t("detail.script.runningNow") } : { kind: "waiting", text: t("detail.script.waitingNext") };
}

/** One ended check as a heading: "Check 3 · not yet · exit 75 · 14:02:11". `locale` formats the time. */
export function checkHeading(check: ScriptOutput["checks"][number], t: ScriptT = english, locale?: string): string {
  const outcome = check.outcome === "not_yet" ? t("detail.script.notYet") : check.outcome;
  return [
    t("detail.script.check", { n: check.n, outcome }),
    ...(check.exitCode === null ? [] : [t("detail.script.exit", { code: check.exitCode })]),
    ...(check.trigger ? [triggerLabel(check.trigger, t)] : []),
    new Date(check.endedAt).toLocaleTimeString(locale),
  ].join(" · ");
}

/** The last `max` lines of a tail, so a long one does not fill the sheet. */
export function lastLines(text: string, max: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.length > max ? lines.slice(-max).join("\n") : lines.join("\n");
}
