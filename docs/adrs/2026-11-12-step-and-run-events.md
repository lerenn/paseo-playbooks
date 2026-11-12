# Step and run events

Status: Accepted

## Context

`subscribe_events` only told a manager about gates, failed runs and lost managers. Nothing fired
when a step ended or a run completed, so a manager that wanted to wait had to poll `list_runs` or
`list_events`.

## Decision

Four new types on the generic bus, produced by `OversightProducer` like the others:

- `step.started`: `runId`, `playbook`, `runName`, `projectId`, `workspaceDir`, `stepId`, `attempt`.
  Once per attempt of an agent or script step (a retry or a loop pass is a new attempt).
- `step.completed`: the same plus `outcome`, the outcome that was applied (failure outcomes and
  retried ones included; for a gate or ask, the outcome the decision gave; for a branch step, the
  case that won, with `attempt` null). Gate and branch steps have no `step.started`.
- `run.completed`: the run fields. Fires when the main steps are done; after-tasks may still run.
- `run.canceled`: the run fields plus `reason` (or null). Spelled like the run status `canceled`;
  `run.cancelled` is not an alias (a subscription to it is refused as an unknown type).

The producer reads the run's history (`step_started`, `step_outcome`, `step_completed`,
`run_completed`, `run_canceled`) from a per-run cursor, not the run's state, so a step that starts
and ends between two scans is still announced. On its first scan after a daemon restart the cursor
is set to the end of each history, so past transitions are not emitted again. Singleton-train runs
(hand-off jobs) emit nothing. Within a scan, `gate.decided` comes before the `step.completed` and
`run.completed` it caused. These events carry no `actors`: the plugin does not know which agent
made the call, so the manager is notified of its own `complete_step` too; filter on `stepId` or
`runId` to narrow it down.

Filters and replay need nothing new: `runId`, `playbook`, `runName`, `projectId`, `workspaceDir`,
`stepId`, `attempt` and `outcome` are declared payload fields; delivery (idle or steer), debounce
and `list_events` replay are the bus's own.

## Consequences

- A manager can wait on `step.completed { runId, stepId }` or `run.completed { runId }` instead of
  polling.
- More messages for subscribers of `step.*` or `*`; the default Sidekick `watch` list is unchanged.
- An event is lost if the daemon is down when the transition happens (as for gate events).
