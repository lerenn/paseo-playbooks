# Remove `fanout.workspace: { in: parent }`

Status: Accepted

Supersedes `2026-11-12-fanout-workspace-parent.md`.

## Context

`workspace: { in: parent }` ran fan-out children as separate run worktrees inside one workspace. That split fights
Paseo's model, where a worktree belongs to a workspace (open question upstream: getpaseo/paseo discussion 9480).

## Decision

- The `workspace` block of the fan-out step is removed from the playbook format, the loader, its validation (the
  isolation requirement and the `workspace_name` refusal tied to it) and the runtime. Every fan-out child gets its own
  new workspace, with its own worktree, as before.
- The workspace rule is unchanged: a manager starts more runs in its own workspace only with `isolation: worktree`, via
  `start_playbook` with its `workspaceId` and no `newWorkspace`.
- The fan-out node's progress line in the run graph is kept.

## Consequences

- A playbook that sets `workspace:` on a fan-out step is now refused as an unknown field. It existed for one release.
