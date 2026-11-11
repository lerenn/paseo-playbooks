# Wait for tokens: a step may wait for a provider to recover

Status: Accepted

Extends `2026-11-10-provider-fallback-tiers.md`, whose fail-over and `exhausted_for` stay valid.

## Context

When every provider of a role is out of tokens, the failure goes to the manager, which can only
retry (using a retry, probably failing again) or give up. Limits reset, so a run that could simply
wait ends up failed or needs a human to restart it.

## Decision

- New keys in the `providers` block of `defaults/main.yaml` (strict, as before):
  `on_exhausted: fail | wait` (default `fail`: today's behaviour) and `max_wait` (a duration, parsed
  like `exhausted_for`; default no limit; it is a load error without `on_exhausted: wait`). Loaded as
  `playbook.onExhausted` and `playbook.maxWaitMs` (`null` = no limit).
- With `wait`, when a step agent's turn fails on quota and no target of its chain is available, the
  attempt is not failed: the step stays `running` and the attempt gets `waiting: { since, until }`
  (null by default, so older run files load). `until` is the earliest end of `exhausted_for` among
  the chain's targets, at most `since + max_wait`.
- A plugin timer fires at `until` (re-armed when the plugin starts, and delayed a minute at a time
  while the run is paused). It restarts the same attempt on the first target that is back, with the
  same prompt and no retry used (the same path as a fail-over; the new agent gets a whole timeout
  and silence window). If every target is still out it waits again. Once `max_wait` is spent, or the
  new agent cannot start, the attempt fails to the manager as with `fail`.
- A waiting attempt has no timeout and no silence check. The manager is told once, with the time
  of the restart, and that it must not nudge or complete the step. Run-log lines: `provider_waiting`
  and `provider_resumed`.
- UI: the step node in the run graph shows "Waiting for tokens until HH:MM", and the step sheet
  adds it to the status line.

## Consequences

- A run can wait for a long time (a weekly limit resets in days); the cap is opt-in, so set
  `max_wait` where that is not wanted.
- `exhausted_for` is a guess at the reset time, so a wake-up may find the provider still out: each
  such probe costs one failed turn, once per `exhausted_for`. Reading the reset time from the error
  text is left out as it differs per provider and is fragile.
- Only step agents wait. Gate deciders and the manager keep today's behaviour.
