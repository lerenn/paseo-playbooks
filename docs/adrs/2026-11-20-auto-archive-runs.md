# Archive finished runs by themselves (opt-in `auto_archive`)

## Status

Accepted. Builds on [archive_run](2026-11-10-archive-run.md) and
[archive the workspace with the run](2026-11-17-archive-workspace-with-run.md).

## Context

A run that ended with nothing left to do (no open gate, no open hand-off job, nothing running)
kept its idle manager agent and stayed in `list_runs` until someone called `archive_run`.
Coordinators had to sweep them by hand.

## Decision

- New block `auto_archive: { enabled, after }` in `defaults/main.yaml` (so also a profile's
  defaults) and in a playbook; a playbook's value wins. `after` is a duration, default `30m`,
  counted from when the run ended (the later of its end event and its last update).
- **Off by default** (`enabled: false`). Archiving hides runs from `list_runs` and archives the
  manager agent; with `archive_with_run` (default true) it can also archive the workspace. A
  failed run hidden before anyone looked at it, or a manager a human was about to talk to,
  is not a safe surprise for every installation, so the plugin does not do it unasked.
- A sweep in the tick (`autoArchiveRuns`) picks candidates from memory only (no daemon call), looks
  into at most 3 runs per tick, and leaves a run it did not archive alone for 10 minutes. It follows
  the [non-blocking rules](2026-11-18-non-blocking-hooks-and-reload.md): hooks and RPCs never wait for it.
- A run is archived only when it is ended (completed, failed or canceled), not a pipeline or
  batch, and has no pending gate, no open hand-off job it handed off, no running after-task,
  and its manager is not in a turn or waiting on a permission.
- The run is archived through the same path as `archive_run`, so the workspace is handled by the
  existing checks (`workspaceArchived` / `workspace_kept`): uncommitted or unpushed commits keep the
  workspace. The run is still archived then, and the event carries the reason.
- The manager agent is archived only when it carries the plugin's manager label (a `restart_run`
  `takeOver` may have made a human's agent the manager) and no other unarchived run uses it.
- `restart_run` still works: it creates a new manager when the old one is archived.
- New event `run.auto_archived` (run fields, `managerArchived`, `workspaceArchived`,
  `workspaceReason`) and a `run_auto_archived` history entry.

## Consequences

- Nothing changes for anyone who does not set `auto_archive.enabled`.
- A run snapshot gains `playbook.autoArchive` (default off for older runs).
- With it on and `archive_with_run` on, a created workspace is archived 30 minutes after the
  run ended instead of at `workspace.archive_after` (6h); set `archive_with_run: false` to keep it.
