# A Sidekick's finished subagents have their hidden workspace archived

## Status

Accepted. Relates to `2026-11-17-archive-workspace-with-run.md` (`workspace.archive_with_run`) and
`2026-11-17-worktree-auto-cleanup.md`; extends the `sidekick.subagents` block of the Sidekick files.

## Context

A project's Sidekick creates a subagent (Paseo's `create_agent`) for every job. The subagent's workspace and the
subagent stayed after its report, so the sidebar and the disk filled with workspaces nobody opened again. Two
findings shaped the fix:

- `create_agent` called **without a `workspaceId`** does not make a hidden worktree: Paseo puts the subagent in the
  project's own checkout. Archiving that workspace would archive a real checkout.
- `create_agent` is Paseo's own tool. The plugin cannot add a `background` flag to it; Paseo's `create_workspace`
  does take `background: true` and `isolation: worktree`.

## Decision

1. **Where subagents live.** The Sidekick prompt tells it to create a hidden worktree workspace first (`create_workspace`
   with `isolation: worktree`, `background: true`, `path` the project root) when a job needs a place of its own, then to
   pass that `workspaceId` to `create_agent`, and never to call `create_agent` without a `workspaceId`.
   `create_workspace` joins the tools the Sidekick may use without asking. This is a prompt rule: the plugin cannot
   force it on Paseo's tool, which is why the archive guards below do not trust it.
2. **Archive.** When the Sidekick has been told that its subagent finished (the finish notice was delivered, at once
   or when it became idle), the plugin saves a pending archive (`sidekick-archive.json` in the data directory: agent,
   workspace, project, due time). After the grace period it archives the subagent and its workspace. A new finish of the
   same subagent moves the due time back. Entries are read again at startup and re-armed with the time left, so a plugin
   reload or daemon restart neither loses an archive nor runs it early; overdue ones run at once.
3. **Setting**, in the existing block: `sidekick: { subagents: { archive_workspace: true, archive_after: 10m } }` in
   `sidekick/sidekick.yaml`. Both optional; `archive_after` is a duration of at most 24h. The setting is read again when
   the grace ends, so turning it off cancels pending archives.
4. **Default on**, as the human asked: the workspaces are created by the Sidekick for one job, are hidden, and the guards
   below keep anything that could hold work. A grace period (10 minutes) lets the Sidekick read the report first.
5. **Guards** (`subagentWorkspaceRefusal`, all must hold; when a fact cannot be read, the workspace is kept):
   - ownership: the workspace is a worktree that Paseo manages (`workspaceKind: worktree` with a slug) and is
     hidden (`background`), its directory is not the project root, and it is not the Sidekick's own workspace. A project
     root or local checkout, a visible workspace and a directory workspace are never archived, even when the subagent
     was created in one by a `create_agent` without `workspaceId`;
   - no run (archived or not) has that workspace;
   - no other live agent lives in it, so a human-opened agent keeps it; the agent must be a subagent of the project's Sidekick;
   - the subagent is not running, initializing or waiting on a permission;
   - no uncommitted changes (`dirtyPaths`, the check of the worktree cleanup, ignoring `.cache` and `.tmp`) and no commits
     that are on no remote-tracking ref (`unpushedCommits`).
   A kept workspace is logged with the reason; the pending entry is dropped and the next finish of the subagent starts a new grace.

## Consequences

- Same spirit as `workspace.archive_with_run` (archive only when nothing could be lost), but a different owner and trigger,
  and on by default because the workspace is hidden and made for the job; `archive_with_run` stays opt-in. Neither touches
  a run's worktree, which the worktree cleanup owns; a run's workspace is excluded here.
- Ownership is inferred (hidden worktree, no run, one agent), not recorded by Paseo, because `create_workspace` has no
  owner or label. A human who hides a worktree workspace and starts a Sidekick subagent in it would get it archived once
  it is clean and pushed. 
- No `archive` outcome is written to a run, as there is none: the plugin logs the result.
- A Sidekick prompt of an existing Sidekick changes at its next restart.
