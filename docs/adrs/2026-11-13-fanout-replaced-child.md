# Fan-out: a replaced child stays one item

Status: Accepted

Builds on `2026-11-12-fanout-join.md`.

## Context

A child's manager sometimes cancels its run and starts a new run of the same playbook for the same item ("Restarting on
the fixed playbook"). The fan-out counted the canceled run as an ended (failed) child and never followed the new one, so
it could report `some_failed` or `all_completed` while the ticket was still being worked, and nobody could tell which new
run belonged to which item.

## Decision

- **Chain.** A fan-out child (`FanoutChild`) gets `previous`: the earlier runs of the item (run id, status, reason, end time,
  who linked it), oldest first. `runId` and `status` are the current run's. Old run files load with an empty chain.
- **Declaring a replacement.** Tool `replace_child { runId, newRunId, reason? }` (any non-step agent, like `cancel_run`), and
  `start_playbook { ..., replaces, replaceReason? }`, which checks first, starts the run in a new workspace and links it.
  The new run (or its reservation, while its manager is still creating it) gets the item's `parent` link; the item goes
  back to `starting` under it and follows it as any child, including the start timeout.
- **Semantics.** The item never counts as ended while the chain has a live run: it keeps its slot (no double slot), its
  position, and the join waits for the last run. The replaced run is a record in the chain, not a failure of the item.
  Replacing a run that is still active cancels it (link first, then cancel, so a scan cannot free its slot in between). A
  replacement of an item the scan already saw as ended reopens it while the step is running; a waiting item may then have
  taken the slot, so `max_active` can be exceeded by replacements only.
- **Automatic case.** `restart_run` of a child keeps its run id and parent: when the scan sees an ended item whose run is
  active again, the item follows it (running) and records the earlier end in the chain.
- **Refused** with a message: a run that is not a child of a *running* fan-out step (an ended fan-out is not reopened), a
  new run of another playbook (inputs may differ), a new run attached to another item, a self-replacement, a run already
  replaced (the error names the current run), an unknown run. Repeating a link is a no-op (`changed: false`).
- **Visible.** `get_run` of the parent: `children[].previous`; `results` entries gain `restarts` and `previous_runs`; run
  summary `previous`; the lane shows `restarted ×N` with the earlier runs one tap away; run log `fanout_child_replaced`;
  bus event `fanout.child_replaced`.

## Consequences

The chain lives in the run file, so a daemon restart keeps it; a replacement whose reservation (in memory) is lost
becomes `not_started`, as any child whose start was cut. The fan-out outputs are unchanged (counts are per item). A
replacement started after the fan-out ended cannot be attached; the manager starts it on its own.
