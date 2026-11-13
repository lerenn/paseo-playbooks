# Fan-out work pool: a fan-out that refills while it runs

Status: Accepted

Builds on `2026-11-12-fanout-join.md` (children, keys, join) and `2026-11-13-fanout-replaced-child.md` (an item stays one item
while its chain runs).

## Context

A fan-out is a batch: the list is evaluated once, and the only way to work items that depend on earlier ones is a `goto` loop
after the join. The loop starts only when **every** child has ended, so an item unlocked by an early finisher waits for the
slowest sibling. Wanted: a fan-out that behaves as a pool. When a child finishes, the playbook looks again at what is ready
(given what is done) and adds the new items to the same fan-out, up to `max_active`; it ends when nothing runs and nothing new
is ready.

## Decision

**Format.** An opt-in block `pool` under `fanout`, with a nested `refill` block (a pool may get other options later):

```yaml
fanout:
  playbook: job
  items: "{{ inputs.items }}"
  key: "{{ item.id }}"
  max_active: 3
  pool:
    refill:
      playbook: unlocked_jobs               # a playbook of the same folder
      inputs: { done: "{{ pool.done }}" }   # templates over pool.* and inputs.<name>
      items_output: items                   # default; a list output of that playbook
      after: completed                      # default; or ended
      max_refills: 20                       # default 20, at most 500
      debounce: 10s                         # optional
```

Without `pool` nothing changes (a batch). A pool step gets the extra outcome `refill_stopped` and the outputs `refills`,
`added`.

**A pass is a run of a playbook, not a re-run of steps of the parent.** Steps of a run have one state each (status, attempts,
outputs), and the engine, the UI and the recovery code assume a step runs one attempt chain at a time. Re-running the parent's
steps beside the running children would either corrupt that state or need a second, parallel step state machine. A
pass instead reuses a mechanism that already exists: it is a run of a playbook of the folder, started like a child (own
workspace and manager, `parent: { runId, stepId, key: "refill:<n>" }`), with its own steps, attempts, gates, retries, usage
checks and visibility. Its output (`items_output`) is the list the fan-out consumes. The author moves the "read the project,
select what is ready" steps into that playbook, which receives the finished keys. The cost is one workspace and manager per
pass (as for a child) and that the first batch comes from the parent's own steps. Rejected: `refill: { steps: [...] }` /
`goto` into the parent's own steps (state conflict above).

**Pass inputs.** `pool.done` (completed keys), `pool.failed`, `pool.active`, `pool.pending`, `pool.known` (JSON lists of keys)
and `pool.refill` (the number). At load time a pool is refused when the pass playbook is missing, recursive or a singleton,
does not declare the `items_output` as a list (or string), misses a required input, or when **no input reads a `pool.*` value**
(a pass that cannot know what is done lists the same items forever).

**Triggers and serialization.** A pass is due when a child that counts (`after: completed`: completed; `ended`: also failed
and canceled; a child whose chain is being replaced has not ended) is not yet in `pool.handled`, the debounce has passed (since
the oldest such ending and the previous pass), the pool is open and `max_refills` is not reached. At most one pass is in
flight. Endings during a pass leave their keys unhandled, so exactly one follow-up pass becomes due after it (coalescing).
The pass records the finished keys it was given; when it completes, those still finished become handled. A replaced child's key
leaves `handled`, so its next ending triggers a pass again.

**Applying a pass.** When its run completes, the items are parsed and diffed by key against **all** children. Items not
present are appended as `pending` children (started under `max_active` as before; the pass's run uses no slot), items present
are counted as `skipped` and ignored. The children and the pass record (`status`, `added` keys, `skipped`, `output`) are
written in one state change (one run-file write), so a crash cannot leave a child without its pass or a key twice, and a pass
repeated after a crash adds nothing new. A list that is not usable or whose keys clash fails the pass.

**End.** The step joins when every child has ended, no pass is in flight and none is due (or the pool is stopped). An empty
first list completes at once. If `max_refills` is reached with endings still unhandled, the pool stops (`refill_stopped`).

**Failure.** A pass that fails, is canceled or gives no usable list stops refilling; running children are never killed, the
step waits for them and ends with `refill_stopped` (fails the run unless `on` routes it, like `some_failed`). Failures inside
the pass follow the pass playbook's own rules. Safety bounds: `max_refills` (default 20), the step `timeout` (default for a
pool 12h when unset), `debounce`; the provider-usage check applies to the pass's agents as to any run's.

**State and recovery.** `FanoutState.pool` (`refills`, `lastRefillAt`, `added`, `handled`, `status`, `stopReason`, last 50
`passes`) is in the run file (older files load with `pool: null`). A pass is `starting` before its run exists. After a daemon
restart the plugin follows a pass whose run exists; one whose creation the restart cut becomes `lost` and runs again (it does
not count against `max_refills`; the key diff makes the repeat safe). Canceling or failing the parent, resetting the step or its
timeout cancels the in-flight pass with the children. A paused run starts no new pass or child. All state changes go through
the run's store lock as the rest of the fan-out does.

**Visible.** The lane header shows `N running · N done · N queued · refills N`; the refill passes are listed under it
(`Refill #n · added …` / `added nothing`), append-only, and in the step sheet with the keys given. `get_run` has
`pool: { refills, lastRefillAt, added, status, passes[] }` on the fan-out step; run log `fanout_refill_started`,
`fanout_refill_ended`, `fanout_refill_stopped`; event `fanout.refill` (phase `started`/`ended`, `doneKeys`, `added`).

## Consequences

- The relation to `goto` loops is unchanged where there is no pool; with a pool the "wait for the whole batch, then loop back"
  is replaced by passes while children run.
- Each pass costs a workspace and a manager; use `debounce` and `after` to limit them.
- Lists passed to the pass are at most 200 keys (a `list` input) unless the input is a string.
- Not built: running the parent's own steps as the refill, passes in the parent's workspace, a total-children cap beyond
  `max_refills`, early cancel of siblings.
