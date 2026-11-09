# `restart_run` can move a run to another workspace

Status: Accepted

## Context

A run that failed with "manager lost (archived)" could not be restarted when its workspace
had been deleted, or was busy with another active run (one active run per workspace). The
refusal did not say which, and offered no way out.

## Decision

- `restart_run` takes an optional `workspaceId`. When the run's workspace is gone or has
  another active run, the run moves to that workspace: it must exist, belong to the run's
  project and have no active run. The run's `workspaceId`, `workspaceDir` and `branch` (the
  target's current ref) are updated and a `run_moved` entry goes in the history.
- A moved run always gets a new Playbook Manager in the target workspace (or the caller, with
  `takeOver`, if it is an agent of that workspace). Completed steps keep their outputs.
- Without `workspaceId`, a refusal says why: the workspace no longer exists, or which run is
  active in it, and suggests `workspaceId`.
- Not done: creating the workspace from the run's `branch`. The caller creates one
  (`create_workspace`) and checks out the branch if the work lives there.

## Consequences

- Additive: the panel's restart is unchanged (same workspace); the parameter is on the tool.
- Step agents of the old workspace are not moved; steps restarted run in the new one.
