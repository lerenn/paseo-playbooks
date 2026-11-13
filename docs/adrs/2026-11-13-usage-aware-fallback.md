# Usage-aware fallback: skip a full provider before starting on it

Status: Accepted

Extends `2026-11-10-provider-fallback-tiers.md` and `2026-11-10-wait-for-tokens.md`, whose chains,
failure-based fail-over, `exhausted_for` and `on_exhausted` stay valid.

## Context

Fail-over only reacts to a failed turn: a run starts on a provider that is already at its weekly limit,
spends a turn failing, and only then moves on; every new run repeats it, as `run.exhausted` is per run.
The daemon already knows each provider's usage (`paseo usage`, `PaseoApi.providers.listUsage()`: per
provider, windows with `usedPct`, `remainingPct`, `resetsAt`).

## Decision

- New block `providers.usage: { check, threshold }` in `defaults/main.yaml` (strict; `check` default
  `true`, `threshold` a percentage in (0, 100], default `100`). Loaded as `playbook.usageCheck` and
  `playbook.usageThreshold` (run state defaults, so older run files load).
- Before choosing a target for a step agent, a gate decider or a manager, the plugin calls
  `providers.listUsage()` and walks the tier's targets in playbook order, skipping every target whose
  provider has a window with `usedPct >= threshold` (or `remainingPct <= 0`). It starts on the first
  target not skipped, without testing it. The manager-given `model` override is not checked.
- Model windows: a window id of the form `<x>_model_<name>` (`weekly_model_fable`) counts only for a
  target whose model id contains `<name>` (or the reverse); for any other model it is ignored. Other
  windows are provider-wide. A full window whose `resetsAt` has passed is ignored (stale cache).
- Safety: a provider with no entry, a status other than `available`, no windows, or a failed read is
  usable. The call is never forced to refresh. The failure-based fail-over is unchanged and remains the
  safety net; usage only improves the order.
- Cost: one shared in-flight call, reused for 45 s (shorter when the daemon's `nextRefreshAt` is
  sooner), a failed read for 15 s. It is host-wide: new runs skip a full provider from the start.
  `run.exhausted` (failures) stays per run.
- When every target is skipped the step still starts on the primary; its first quota failure then
  takes the existing paths. With `on_exhausted: wait` the wake-up is the earliest reset time of the
  provider windows (else `exhausted_for`), so a wake-up is never in the past; `fail` and `max_wait`
  behave as before. The same check applies when a waiting attempt wakes.
- Visibility: a `provider_usage_skip` run-log line (target, window, percentage, reset time; once per
  target and reset), the `start_step` result (`skipped`) and the fail-over notice to the manager. No UI
  change.

## Consequences

- A run no longer burns a turn on a provider known to be full, and a waiting step wakes at the real reset.
- The daemon caches usage, so a reading may lag; a provider read as free that is in fact full still
  fails over by failure.
- A step whose whole chain is full still costs one failed turn before it waits (or fails).
- The threshold applies to every window of a provider, including a short one (5-hour) that resets soon.
