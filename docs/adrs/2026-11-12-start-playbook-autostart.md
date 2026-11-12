# `start_playbook` starts the first ready steps (`autoStart`)

## Status

Accepted

## Context

`start_playbook` created a run whose first steps were ready, and nothing started them until the run's Playbook Manager called `start_step`. A run started by a coordinator or the Sidekick (through a new manager) could sit idle if that manager did not act.

## Decision

1. `start_playbook` takes `autoStart` (boolean, default `true`). When true, after creating the run it starts every ready agent step through the same code path as `start_step` (`Runtime.autoStartReady` calls `startStep` with an empty brief and no model override: same model resolution, role and workspace). Script and hand-off steps are not started (the plugin runs them itself); gates are still opened with `request_gate`. A step that cannot start is reported in the result and stays ready.
2. The result tells the manager which steps were already started and which ready ones were not, and `MANAGER_PROTOCOL` and the manager kickoff say so. Starting is idempotent in effect: `start_step` already refuses a step that is not `ready`, so a manager that calls it again is refused cleanly.
3. The layer is the manager's own `start_playbook` call. Runs begun from the panel or by a Sidekick or `workspaceId` create a manager whose kickoff calls `start_playbook`, so they get the same behaviour. `autoStart: false` on the coordinator path is forwarded to the kickoff: the new manager creates the run and leaves the ready steps unstarted until told.
4. The panel's RPC is unchanged; only the manager's kickoff text differs.

## Consequences

- Steps start without a brief from the manager; the manager can still `nudge_step` to add context. Use `autoStart: false` to brief the first steps first.
- A manager from an older prompt that calls `start_step` right after `start_playbook` gets a refusal, harmless.
