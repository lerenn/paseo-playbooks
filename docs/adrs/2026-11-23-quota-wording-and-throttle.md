# Quota tab wording (Max usable quota, Pace ceiling) and a throttle gauge per provider

Status: Accepted. Refines `2026-11-23-quota-limitation-project-rows.md` (its collapsed line and provider block), and the wording of
`2026-11-23-quota-limitation-per-project.md` and `2026-11-23-quota-limits-in-defaults.md`.

## Context

The tab and the docs called two different things "pacing": the setting (`quota_limits.quota.pacing` and `usable_percent`) and the
value that rises with time through a usage window. A project could read "Pacing 90%" next to "Pace ceiling 1%". Also, nothing said how
hard new work was held on a provider: only "free X%" or "over the pace".

## Decision

**Wording** (user-facing text only; config keys, field names, events and `rateHold` kinds are unchanged):

- The setting is **Max usable quota** (`Max usable quota 90%`, or `Max usable quota off`). It replaces "pacing is on/off".
- The value that rises with time is the **Pace ceiling** (`usable_percent` × elapsed / window length, never above `usable_percent`).
  "Not paced" becomes "no pace ceiling"; "over the pace" becomes "over the ceiling" (`claude 3% over the ceiling`).
- "Held" and "paused" keep their meaning. fr: "Quota utilisable max.", "Plafond de rythme"; zh-CN: "最大可用配额", "节奏上限".

**Throttle**, per provider in an opened project row (it uses the project's own `usable_percent` and runs), one line with a violet bar
(the `paused` semantic tone, as on hold) and a number:

`throttle = max over the provider's paced windows of clamp(1 − free / need, 0, 1)`, shown as a percent.

- `free` = the window's pace ceiling − usage − every reservation (the tab's "Free"; the planner's own test: a run starts when `free`
  covers its cost). `free ≤ 0` gives 100%.
- `need` = the median remaining need on that window of the project's runs admitted or queued on the provider (a held run with no
  reservation counts with the `estimatedCost` of its hold); with none, the largest measured cost of one step of the project's
  playbooks. Needs of at most 0.05 points (the planner's zero cost) are ignored.
- No measured need: "Throttle: no estimate" (nothing is held for cost). Zero-cost runs and runs with no history are never throttled.
- Why not the pace plan's verdict: it is per run and not stored for runs that are not held, so it cannot say how close a provider is
  to holding. This formula reads the same numbers the planner compares and needs no new data.
- Beneath it: `N held · N paused · longest wait Xh Ym · next retry HH:MM`, from the runs' `rateHold` (`kind` pace = paused, others =
  held; oldest `since`; the next `retryAt` still to come). The caption states the formula in one line. The collapsed row adds the word
  "throttled" when any provider of the project is above 0%.

## Consequences

- Read-only. The RPC payload grows by optional fields only: `since` and `estimatedCost` on held runs (copied from `rateHold`) and
  `unitCost` per project (measured step costs). Nothing new is stored; an older server leaves them out and the line shows the counts only.
- A step costs less than a whole run, so the playbook fallback understates a run's need and the throttle can read low until a
  run of the project is admitted or queued.
