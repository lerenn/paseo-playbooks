# Archiving a run archives its workspace, when asked and when safe

## Status

Accepted. Extends `2026-11-10-archive-run.md` (archive_run only hid the run) and the `workspace`
block of `2026-11-09-isolation-worktree.md`; relates to `2026-11-17-worktree-auto-cleanup.md`.

## Context

`archive_run`, the panel's archive button and a manager's archive only hide the run. Its Paseo
workspace (directory, manager and step agents, leftover subagents) stays, so after archiving many
runs the workspaces have to be archived by hand. `archive_workspace` archives every agent in a
workspace, and some workspaces are shared by two runs or hold an agent a human opened.

## Decision

1. A new option in the existing `workspace` block, also allowed in a playbook and in
   `defaults/main.yaml`: `workspace: { archive_with_run: false }`. It goes in the existing block, not in a
   new `workspaces` block, because `workspace` already holds what happens to a run's workspace. The
   playbook's own value wins over the default.
2. **Default false.** Archiving a workspace archives every agent in it and changes what existing
   users see after an archive, so it is opt-in.
3. When a run is archived (the `archive_run` tool, the panel button, or its manager being archived,
   the first time only) and the option is on, the plugin archives its workspace only if: no other
   run that is not archived uses the workspace; no agent in it runs, is initializing or waits on a
   permission; the run has ended (archiving already requires it); the workspace still exists (not
   already archived); and every visible agent in it carries a plugin label (manager, step, run or
   gate), so a human's own agent, the Sidekick or an unlabeled subagent keeps it. Otherwise the
   workspace is kept, `workspace_kept` is written in the run's history and the reason is logged. A
   success writes `workspace_archived`.
4. `archive_run` returns `workspaceArchived` (true/false) and `workspaceReason` in its result data
   (absent when the run was already archived: nothing was tried).
5. `restart_run` of an archived run whose workspace is gone keeps working: it refuses in place with
   the existing message and restarts with its completed steps kept through its `workspaceId`
   parameter (an existing workspace of the same project with no active run). Covered by a test.
6. Relation to the worktree cleanup (v0.116.0): an isolated run's worktree is a plugin-managed git
   directory, removed by `cleanupEndedWorktrees` from the run's state and from the agents labeled
   with the run that are still running. Archiving the workspace touches neither the directory nor
   that state, and an archived agent is not counted as running, so the two never act on the same
   thing and nothing is cleaned twice. It also does not replace `workspace: { archive: on_end }`,
   which archives, at the end, a workspace the plugin created; with both on, the second sees the
   workspace gone and records it kept.

## Consequences

- Run state's `playbook.workspace` gains `archiveWithRun` (defaults to false for old runs).
- Archiving the workspace archives the manager and step agents: a manager archive then re-enters
  the plugin's archive hook, which is a no-op for the run already archived.
- Unlabeled leftover subagents keep the workspace; the human archives it by hand, as before.
