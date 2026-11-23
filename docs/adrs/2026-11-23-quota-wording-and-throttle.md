# Quota tab wording (Max usable quota, Allowed so far) and a throttle gauge per provider

Status: Accepted (the name "Pace ceiling" is superseded by `2026-11-23-allowed-so-far-wording.md`). Refines `2026-11-23-quota-limitation-project-rows.md` (its collapsed line and provider block), and the wording of
`2026-11-23-quota-limitation-per-project.md` and `2026-11-23-quota-limits-in-defaults.md`.

## Context

The tab and the docs called two different things "pacing": the setting (`quota_limits.quota.pacing` and `usable_percent`) and the
value that rises with time through a usage window. A project could read "Pacing 90%" next to a "Pace ceiling 1%" (the first name of the rising value, renamed below). Also, nothing said how
hard new work was held on a provider: only "free X%" or "over the pace".

## Decision

**Wording** (user-facing text only; config keys, field names, events and `rateHold` kinds are unchanged):

- The setting is **Max usable quota** (`Max usable quota 90%`, or `Max usable quota off`). It replaces "pacing is on/off".
- The value that rises with time is **Allowed so far** (it was first called "Pace ceiling"): Max usable quota × the share of the window already elapsed, never above Max usable quota. It replaces "Pace ceiling" everywhere a human reads it, including the hold examples.
  "Not paced" becomes "no allowed-so-far figure"; "over the pace" becomes "over the allowance" (`claude 3% over the allowance`).
- "Held" and "paused" keep their meaning. fr: "Quota utilisable max.", "Autorisé à ce stade"; zh-CN: "最大可用配额", "到目前为止可用".

**Throttle**, per provider in an opened project row (it uses the project's own `usable_percent` and runs), one line with a violet bar
(the `paused` semantic tone, as on hold) and a number:

`throttle = max over the provider's paced windows of clamp(1 − free / need, 0, 1)`, shown as a percent.

- `free` = the window's allowed so far − usage − every reservation (the tab's "Free"; the planner's own test: a run starts when `free`
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
