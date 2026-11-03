# Any agent can list and cancel runs

Status: Accepted

## Context

`cancel_run` was a manager tool and only worked on the caller's own run. When a human asked
another agent, for example in a different workspace's chat, to cancel a run, that agent had
no tool for it. The human had to open the Playbooks panel.

## Decision

- `cancel_run` and a new `list_runs` tool go to every agent except step agents, like
  `validate_playbooks`. Managers keep them.
- `list_runs` lists the daemon's runs that are not archived, by default only active ones,
  with their workspace, branch, manager and running steps.
- `cancel_run` takes any run id. Without one it picks the caller's own active run, or else
  the only active run of the caller's workspace. Otherwise it refuses and lists the active
  runs.
- When the canceller is not the run's manager, the manager is woken with who canceled and
  why, the same way as a cancel from the panel.
- Step agents still cannot cancel: a step ends through `report_step_result`.

## Consequences

- A human can stop a run from any chat, with no ownership check: every agent on the daemon
  can cancel every run, as the panel can.
- `cancel_run` is no longer manager-only, which changes the tool table in section 5 of
  `2026-11-02-design.md`.
