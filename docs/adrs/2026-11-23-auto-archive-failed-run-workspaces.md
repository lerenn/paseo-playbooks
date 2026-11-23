# auto_archive: a failed run's workspace follows its restartability

## Status

Accepted. Extends [auto_archive](2026-11-20-auto-archive-runs.md): replaces its rule that the
workspace of every ended run goes with the run, for a failed run that can be restarted.

## Context

`auto_archive` archived any ended run, failed ones included, and tried to archive its workspace
once, at that moment (through `archive_run`'s `archive_with_run` checks). `workspace.archive_after`
skips failed runs. So a failed run's workspace was either archived 30 minutes after the failure,
when a human might still want to restart it in place, or, if that one check refused (unsaved
work, a running agent), never looked at again.

## Decision

- New option in the existing block: `auto_archive: { enabled, after, keep_failed_workspace }`, a
  duration, default `24h`, in `defaults/main.yaml`, a profile's defaults or a playbook (the
  playbook wins).
- A failed run **that cannot be restarted** (`restartableFrom` empty): as before, its workspace is
  archived with the run, `after` the failure.
- A failed run **that can be restarted**: the run and its manager are archived `after` the
  failure as before, but its workspace is kept and archived `keep_failed_workspace` after the
  failure, by a second sweep (`autoArchiveFailedWorkspaces`) with the checks of
  `workspace.archive_with_run`: no uncommitted or unpushed work, no running agent, only plugin
  agents, and no other run active in it. A refusal is written once (`workspace_kept`).
- The period counts from the failure (the end event), not from later updates of the run.
- A run restarted in the meantime is not failed, so nothing is archived; when it fails again the
  period starts again. `restart_run` clears the run's workspace-archive marker for that.
- Only with `archive_with_run` on (the default) and only for a workspace the run created.
- `get_run` / `list_runs` gain `workspaceKeptUntil` (ISO time, null when not held) and the
  panel's run bar shows it.
- Nothing changes without `auto_archive.enabled`. A manual `archive_run` is unchanged.

## Consequences

- Run state's `playbook.autoArchive` gains `keepFailedWorkspaceMs` (default 24h for older runs).
- In practice almost every failed run is restartable (its first step always can be), so the
  workspace of a failed run now usually lives 24h instead of 30 minutes.
- A workspace with unsaved work is still kept for good; it is archived by hand.
