# A work pool can wait on blockers and keep accepting items (`pool.idle`)

## Status

Accepted

## Context

A pool ends when no child runs and a pass lists nothing new. When unstarted items remain that are only blocked
(they wait on items still running or queued), a playbook that wants to continue loops back with a `goto`, often through
a script step that polls. While that step runs there is no running fan-out, so `add_fanout_item` is refused
("only works on a running fan-out") and a manager cannot add a newly created item. The pool cannot tell "done" from
"nothing ready yet, blockers remain": only the pass playbook knows.

## Decision

- New block `fanout.pool.idle: { output, poll }` (next to `refill`; `poll` default 10m). `output` names an output of the
  pass playbook (the loader refuses one it does not have). A completed pass that lists no new item and whose `output` is
  `true` makes the pool **wait**: the fan-out step stays running and does not join.
- A waiting pool re-plans (starts a new pass, the same transition as after a child ends) when a child ends (as today),
  when an item is added (`add_fanout_item` or the panel), and every `poll`. A pass that does not say `true` lets the
  pool end as usual.
- `add_fanout_item` is accepted while the pool waits (the step is running); the checks are unchanged. The item is
  `pending`, in `pool.known` / `pending`, and never listed again. An add records `wakeAt` in the pool state.
- **Coalescing**: one `wakeAt` flag, cleared when a pass begins. Adds before the pass starts share it; the pass starts
  once `debounce` has passed since the oldest add and the previous pass. At most one pass runs at a time, so an add or
  a child ending during a pass waits for one follow-up pass.
- **`max_refills`**: a re-plan that no child ending triggered (an add, the poll) does not count (`pass.counted: false`):
  counting would make a long wait, polled every `poll`, exhaust `max_refills` and stop the pool, which is what the
  option exists to avoid. A pass after a child ending counts as before, so `max_refills` still bounds the work. The step's
  `timeout` bounds the wait.
- Run events: `fanout_pool_waiting` when a pass leaves the pool waiting; `fanout_refill_started` says when a re-plan is
  not counted and why. `get_run` shows `pool.waiting`.

## Consequences

- Run state gains `pool.wakeAt`, `pass.waiting` and `pass.counted` (defaults load old runs). No other format change.
- Pools without `idle` behave as before.
- The pass playbook (and the playbook around the fan-out) must use it: the planner outputs `waiting: true` when only
  blocked items remain, and the loop-back wait step (`goto`) is then not needed for that case. A playbook keeps its own
  step for the case where nothing can ever progress (a human question): the planner then outputs not-waiting and the pool ends.
- A pass every `poll` while waiting costs a planner run each time; choose `poll` accordingly.
