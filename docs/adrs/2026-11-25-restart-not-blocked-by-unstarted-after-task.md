# A restart is blocked only by an after-task that has started

## Status

Accepted

## Context

`restartBlocker` refused a restart while any after-task was `running`. An auto after-task counts as
running from the moment the run ends, even when its first step is only ready and held by a burn-rate
pace or quota hold. A failed run whose retro waited hours for quota therefore could not be restarted.

## Decision

Only an after-task with started work blocks a restart: one of its steps is running, reported, waiting
at a gate or already ended (`startedAfterTasks`). A task whose steps are all pending, ready or queued
does not block. Restarting cancels such a task (history `after_canceled`, detail `restart`), lifts the
run's rate hold and drops the run's quota reservation; all after-tasks are pending again, so a second
failure queues a fresh retro as usual. `restartableFrom` and the Runs view follow `restartBlocker`.

## Consequences

- A quota-held retro never blocks a restart. Cancelling an after-task that has started is still needed first.
- A retro the user wanted is dropped when they restart before it ran; the restarted run's end launches it again.
