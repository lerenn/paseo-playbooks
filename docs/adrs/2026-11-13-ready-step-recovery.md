# Ready steps the plugin starts itself are recovered, and one damaged run cannot stop the tick

## Status

Accepted

## Context

Every state change ends in the plugin's tick, which starts the ready script, hand-off and fan-out
steps. A pipeline run whose file lacked the state record of some of its playbook steps made one
phase of the tick (`startScripts`) throw. The exception aborted the tick for every run, after the
state change had been written: `resume`, `complete_step` and `cancel_run` of unrelated runs
returned `Cannot read properties of undefined (reading 'status')`, and a fan-out that had just
become ready (run_57b966) was never started. No later tick could start it either.

## Decision

- A run's missing step and after-task records are added (as `pending`) when the store loads it
  and on every mutation (`repairRun`); the ready-step accessors tolerate a missing record.
- Each phase of the tick runs on its own: a phase that throws is logged and the next phases still run.
  Reconcile at plugin start does the same per run, and fan-outs are driven per run.
- At plugin start, an active run with a ready fan-out, hand-off or script step is logged
  `step_recovered` in its history and started by the tick that ends reconcile. Starting re-checks the
  step is still `ready` inside the run's mutation, so it never happens twice.

## Consequences

- A damaged run is repaired, not skipped, and cannot block other runs; `cancel_run` works on it.
- A step dropped by a crash is picked up on the next plugin start; the ordinary tick already
  retries a ready step on every pass.
