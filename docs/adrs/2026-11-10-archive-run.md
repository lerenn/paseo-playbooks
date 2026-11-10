# An `archive_run` agent tool

Status: Accepted

## Context

A run could be archived only from the panel (the `runs.archive` RPC), or implicitly when its manager was archived.
Coordinators and managers that cancel or finish a run had no way to clean it up, so ended runs piled up in the panel.

## Decision

- New agent tool `archive_run` (`runId`, `force`, any agent except step agents, like `cancel_run` and `restart_run`).
  It calls the same `archiveRun` as the panel through `Runtime.archiveRunByAgent`.
- Only ended runs (completed, failed, canceled, with no after-task running) can be archived; an active, paused or
  gate-waiting run is refused with "cancel it before archiving".
- A run whose hand-off job is still open in a pipeline (waiting at a station or riding a train) is refused unless
  `force: true`.
- Idempotent: an archived run returns success with its existing `archivedAt`.
- `list_runs` already hides archived runs and has `archived: true` to include them; unchanged.

## Consequences

- Authorization is the same as `cancel_run`: no manager or coordinator role is checked, and any run id works.
- Archiving hides the run only; agents and state are kept, and `restart_run` can reopen it.
