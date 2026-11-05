# Runs carry on where they were after a daemon restart

Status: Accepted (supersedes the step-agent rule of the restart reconcile in
`2026-11-02-design.md`, section 4)

## Context

A daemon restart cuts every agent's turn. When the plugin starts, it reconciles the active
runs (design, section 4). Until now, a step agent that was no longer running and had not
reported was marked `turnEnd: lost`. The manager then started the step again with a new
agent, which threw away the conversation of the cut one. That conversation is still there
after the restart, and the work it did is still in the worktree.

A manager whose turn was cut could also leave its run stuck. It had already read its last
wake-up, so the inbox was empty and nothing woke it again.

## Decision

- During reconcile, a step agent that exists, is not archived, is not running and has not
  reported gets a prompt in its own conversation: the daemon restarted, carry on from where
  you stopped, then call `report_step_result`. The attempt stays the same, its timeout is set
  again, and the history records `step_resumed`. If the agent is gone or archived, or the
  prompt cannot be sent, the step ends as `lost`, as before.
- After the steps of a run are reconciled, its manager gets a "daemon restarted, call get_run
  and carry on" note, with the ready steps and the steps waiting for `complete_step`. This
  happens only when the run waits on the manager: it is active and not paused, no step is
  running, no gate is pending, no wake-up is already queued, and at least one step is ready
  or reported. A run that is only waiting on its steps, a gate or a `concurrency` slot is
  not woken.
- Script steps, gates and the "manager lost" rule are unchanged.

## Consequences

- A step cut by a restart keeps its context and does not start over. The attempt counts as
  one attempt.
- A plugin reload also reconciles. Agents still running are left alone. An idle manager is
  only woken if its run is stuck on it, which it is whether or not the daemon restarted.
- Recovery still starts at the plugin's first hook or RPC, not when the daemon starts. The
  plugin SDK gives `contribute()` no daemon API and has no "daemon started" event, so fixing
  that needs a change in Paseo core.
- A step's timeout counts from the start of its attempt, so time spent with the daemon down
  counts against it.
