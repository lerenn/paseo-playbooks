# auto_archive: archive a run's leftover agents with its workspace, and retry transient refusals

## Status

Accepted. Refines [auto_archive: a failed run's workspace follows its restartability](2026-11-23-auto-archive-failed-run-workspaces.md):
that decision's "a refusal is written once" now applies only to refusals that cannot clear.

## Context

A failed run's workspace and about nine of its agents stayed listed for a day and a half after its worktree was removed. The
workspace archive (`archive_with_run` checks) treated every agent without a plugin label as "not part of a run". Subagents a step
creates itself carry no plugin label, so one idle leftover subagent refused the archive. The refusal was written once
(`workspace_kept`) and never asked again, so a busy agent at that moment had the same effect.

## Decision

- An agent counts as the run's when it has a plugin label (manager, run, step, gate), when a run in the workspace recorded it
  (manager or step attempt), or when its parent chain (`parentAgentId`, or the `paseo.parent` label) reaches such an agent.
- Before the workspace is archived, every such agent that is idle or finished is archived (the manager is archived by the
  auto-archive pass itself). Nothing is touched while an agent runs a turn or waits on a permission: the workspace is kept and
  asked again. An agent that is not the run's keeps the workspace, for good, and is never touched.
- Refusals are split. **Retryable**: an agent running or waiting on a permission, another run active in the workspace, a failing
  daemon call. **Final**: unsaved or unpushed work, an agent that is not the run's, a workspace that is gone.
- A retryable refusal leaves the run's workspace marker empty. The sweep asks again every 10 minutes (3 runs per tick), for
  `keep_failed_workspace` after the run was archived (after the keep deadline for a held restartable failed run). Then the refusal
  is final (`workspaceArchive: skipped`). A final refusal sets `skipped` at once. A refusal is written to the history once per
  distinct reason.
- Only runs auto-archived by `auto_archive` are retried; a manual `archive_run` is unchanged.
- The run's own worktree (plugin data) plays no part: a removed worktree does not stop the workspace archive.

## Consequences

- No new option and no new run field; state written by older versions works as is.
- A workspace with a stuck busy agent is asked about for up to `keep_failed_workspace` (24h by default), then kept.
- A subagent that was left running by a step still blocks the workspace until it ends.
