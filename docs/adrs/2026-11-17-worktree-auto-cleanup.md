# Ended runs' worktrees are cleaned up automatically, caches first

## Status

Accepted. Refines `2026-11-09-isolation-worktree.md` (removal of an ended run's worktree) and the
`workspace.keep_failed` rule it set: a failed run's worktree is no longer kept forever.

## Context

Tools run inside a run's worktree fill `.cache` and `.tmp` (4–7 GB per run). With a score of
concurrent runs the volume holding `~/.paseo` fills up and later steps stall at a disk guard.
Three things kept worktrees around: a failed run's worktree was kept for good
(`keep_failed` defaults to true), a worktree whose only untracked files were `.cache` / `.tmp`
counted as having uncommitted changes and was kept, and nothing looked again at a kept worktree.

## Decision

1. A run that succeeds or is canceled has its worktree removed as soon as it has ended, as before.
   `.cache` and `.tmp` at the worktree root no longer count as uncommitted changes.
2. A worktree kept because of uncommitted changes has its `.cache` and `.tmp` deleted at once; the
   rest stays for the human.
3. A failed run's worktree (`keep_failed: true`) is kept for 24 hours after the failure, then
   removed, caches included. It is removed earlier whenever the volume holding the worktrees is at
   least 85% used. The kept state records `keptFor: "failed"` so the plugin looks at it again.
   Uncommitted changes and a changed original checkout still keep it, as before.
4. Nothing is removed while an agent of the run runs, while one of its after-tasks runs, or while
   another active run records the same worktree path.

## Consequences

- Run state gains `worktree.keptFor` (optional; old runs read as unset).
- The window (24h) and threshold (85%) are constants, not configuration.
- A failed run's worktree can no longer be inspected after a day; its branch is kept when it holds
  unpushed commits, as for any removal.
