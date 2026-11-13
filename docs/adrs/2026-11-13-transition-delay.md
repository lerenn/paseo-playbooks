# A loop-back can wait: `delay` on a `goto`

## Status

Accepted

## Context

A `goto` sends the run back to an earlier step at once and, without `max_loops`, forever. A
polling loop between a reviewing agent step and a check script whose script misclassified its
answer looped hot: about 150 laps, one full agent session each, for hours. Authors had no way to
space the laps, short of a sleeping script that holds a step (and a timeout) open.

## Decision

- A `goto` transition takes an optional `delay`: `on: { recheck: { goto: check_script, delay: 2m } }`.
  It is a duration parsed like `timeout` (`30s`, `2m`, `1h`); anything else, or `0`, fails the load.
  It sits next to `goto`, `max_loops` and `decider`: it describes the `goto` itself rather than a
  new feature, so it stays a field of that transition block. It applies to `goto` in `on` of every
  step kind that allows `goto`; not to `ask` choices or a loop-limit approval.
- Run state: a step state gets `waitUntil` (ISO, default `null`, so older run files load). The `goto`
  sets it on its target, which stays `pending` and is not made ready before then.
- The plugin's tick has a first phase that makes the due steps ready and sets one timer per step
  to run the tick when it is due; nothing sleeps in the tick. At plugin start the tick finds the
  saved `waitUntil`, so a restart resumes it. A paused run holds its delayed steps until resume;
  a canceled run never starts them; `restart_run` clears the wait.
- UI: the step card adds a "waits until <time>" line while the step waits. The step is not
  `running`, so the live running timer does not count the delay.

## Consequences

- Authors can bound the rate of a loop without a sleeping script; the manager is not woken for the delay.
- A loop-limit gate approved later loops back at once (the delay is not kept on the gate).
