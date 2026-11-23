# Warden: hold-aware checks, a `held` check, and one manager notice per hold

## Status

Accepted. Extends `2026-11-23-warden-stalled-and-repeat-suppression.md` and the quota pacing decisions
(`2026-11-20-rate-limiting.md`, `2026-11-21-pause-admitted-runs-to-fit-pace.md`).

## Context

Since quota pacing, a run can be held (`rateHold`: steps, playbooks, quota, headroom, pace). The state is expected and the
plugin lifts it by itself. Two things went wrong. The warden's time-based checks could read the wait as a fault. And the
manager was told of the hold again and again (a hold lifted and re-taken, for instance by a script start that skips the
quota and so lifted a quota hold, produced a new notice each time), and answered "doing nothing" each time at a token cost.

## Decision

- **Hold-aware checks.** Per check, against a held run (a `ready` step that cannot start, an idle manager):
  - `stalled`: a held run is never stalled; its idle clock restarts at the release (`run_released` is an event).
  - `stale_definition`: the age of the pin does not count the time spent held (`heldMs`, summed from `run_held` / `run_released`, plus the open hold). Its repeat state ignores the hold.
  - `slow`: unchanged. It only looks at `running` steps, which a hold never touches (it applies between steps).
  - `loops`, `gate_open`, `manager_blocked`: unchanged. A hold changes none of their facts: a gate's age, an edge's count and a manager that is idle with a gate only it can decide are true held or not.
- **New check `held`** (`warden.checks.held: { after: 2h, action: report | none }`, on with the other default checks, same shape as `stalled`). It reports an active run, not paused by a human, held for `after` or more from the start of the hold. The finding gives the reason, the provider and usage window, the queue position and priority, the held runs of the same provider and window ahead of it (id and playbook), the estimated cost against the headroom and the retry time. Value = hold minutes, state = hold kind, so the doubling rule of the previous ADR applies. It is announced as `warden.finding`.
- **One manager notice per hold.** The notice is sent when a hold starts, and again only when its kind, provider or usage window differ from the one the manager was last told about. A changed retry time, position, headroom or reason, or a hold lifted and re-taken with the same kind, provider and window, sends nothing. The text is short and still says not to start, retry or restart steps or cancel the run. The release notice is kept, but only when the manager knew of the hold and a step now waits for it (it then has something to do); it also resets the memory, so the next hold is told again. A script start that skips the quota no longer lifts a quota, headroom or pace hold.

## Consequences

- A run held for a day costs its manager one notice, not one per re-check; a held run no longer shows as stalled or as an old pin.
- The memory of what the manager was told is in memory only: after a restart a manager may be told once more, at the next change.
- Config gains `warden.checks.held`; findings gain the `held` check name. Run state is unchanged.
