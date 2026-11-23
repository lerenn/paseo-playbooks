# An admitted run's remaining need comes from the current history

## Status

Accepted. Refines `2026-11-21-pause-admitted-runs-to-fit-pace.md` and `2026-11-23-quota-limits-in-defaults.md`.

## Context

An admitted run's remaining need (what the pace plan takes from the headroom) was its reservation's remainder, `est - spent`, where `est` was fixed when the run was admitted. A run admitted while its playbook had no cost history got an `est` of 0, so its need stayed 0 for its whole life: once the history appeared, the run kept starting steps although the window was over the pace ceiling, because a run with no need is never paused.

## Decision

- At every pace check, and when the Quota limitation tab is built, the need of each admitted run is recomputed from the current history: per-step cost x its remaining agent steps (per provider and window), minus what its running steps have already used (the not yet folded usage of its running attempts). The reservation is stored as `est = spent + need`, so the pace plan, the headroom and the tab all read the same remainder.
- A provider window whose playbook still has no history keeps what the run had (no need: unpaced). A run with no remaining agent step is left alone.
- Unchanged: priority then oldest ordering, manual priority override, a running step is never interrupted, exhausted and unavailable handling, and the zero-cost rule.

## Consequences

- Runs admitted before any history existed become pace-able as soon as history exists and are paused at their next step boundary like any admitted run; the tab lists them in Reservations with the new remaining figure.
- The need now shrinks as steps complete (the old reservation only shrank by measured usage), so a run near its end asks the pace for less.
- A reservation older than six hours is no longer lost for a live run: it is rebuilt at the next check.
