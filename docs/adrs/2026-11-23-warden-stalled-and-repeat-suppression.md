# Warden: a `stalled` check, and fewer repeated findings

## Status

Accepted. Extends `2026-11-18-warden.md`; changes its rule that a finding repeats every cooldown while true.

## Context

A run can sit for hours with nothing running, ready or queued and no gate open, for instance when a review step ends with changes requested, nothing routes it, and the manager is stopped on its provider's quota. No check flagged it: `manager_blocked` needs an open gate and `slow` only counts running steps. Separately, `loops` and `stale_definition` findings repeated at every cooldown for runs in a known long loop or waiting on a gate, which is noise.

## Decision

- New check `stalled` (`warden.checks.stalled: { after: 30m, action: report | none }`, on with the other default checks). It finds an active run (not finished, not paused, not a pipeline or batch) with no step `running`, `ready`, `queued` or `waiting`, no running after-task and no open gate, for `after` counted from the run's last event (the warden's own notes excluded). The finding states the idle time, the manager's state (running, idle, gone, or quota-blocked when its last turn ended on a provider out-of-tokens notice), the last event and the steps' statuses. It is announced as `warden.finding`.
- A finding stores `value` and `state` as they were when last reported. A finding that is still true is reported again only after `cooldown` (still the minimum spacing) and when its `value` is at least twice the last reported one, or its `state` differs. A new signature is still reported at once. `loops` uses the count as value; `stalled` the idle minutes as value and the manager's state as state; `stale_definition` the run's status and pause as state. Checks that carry neither keep repeating every cooldown.
- `stale_definition` is not reported for a run that only waits on a gate (an open gate, nothing running, ready or queued).

## Consequences

- A long loop is reported at 2x, 4x, ... its first count; a stalled run at 30 min, then about 2h, 4h, 8h, or when its manager changes state.
- Findings stored before this change have no baseline: the first pass adopts the current value and does not repeat.
- The `warden.finding` event, `get_run`'s `warden` and the panel keep their shape; findings gain `value` and `state`.
