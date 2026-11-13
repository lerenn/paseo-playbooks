# An isolated playbook starts in the caller's workspace

## Status

Accepted. Partly supersedes decision 4 of `2026-11-13-sidekick-gets-start-playbook.md` ("always a NEW workspace") for playbooks with worktree isolation; the rest of it stands.

## Context

v0.100.0 made `start_playbook` always create a new workspace and refuse `newWorkspace: false`. A playbook with `isolation: { mode: worktree }` already runs in a private worktree, and several such runs may share one workspace (`2026-11-09-isolation-worktree.md` lifts one-run-per-workspace for them). Forcing each into a new workspace scatters them away from the user's Playbook panel.

## Decision

1. For a playbook declaring `isolation: { mode: worktree }`, `start_playbook` starts the run in the **caller's workspace**, or in `workspaceId` when given, with the run's private worktree, and a new Playbook Manager there. `newWorkspace` omitted or `false` means this; `newWorkspace: true` still forces a new workspace (`workspaceId` then names the base it branches off). Several isolated runs share one workspace.
2. A playbook **without** worktree isolation keeps v0.100.0: always a new workspace; `newWorkspace: false` is refused with a message pointing to `isolation: { mode: worktree }`.
3. A Sidekick has no workspace to start in (its own is hidden): it always gets a new workspace, even for an isolated playbook, unless it passes `workspaceId` of an existing workspace (its own hidden one is refused). Then the isolated run starts there.
4. `forJob` works in both cases. `workspaceName` only applies to a new workspace.
5. The reserved-workspace exception stays, but is now recognised only when the caller's workspace holds a reservation for that very playbook and (resolved) inputs, so another agent of a workspace that has a pending reservation is not mistaken for the Playbook Manager.

## Consequences

- Tool contract change (where the run starts): minor version.
- An isolated run started by an agent now shows in that agent's workspace Playbook panel; the caller still does not manage it.
- A caller that relied on a new workspace for an isolated playbook must pass `newWorkspace: true`.
