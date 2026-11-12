# Fan-out children can run in the parent's workspace

Status: Accepted

Builds on `2026-11-12-fanout-join.md` and the isolation rule (several runs may share a workspace only with
`isolation: worktree`).

## Context

A fan-out step always started each child in a new workspace (`workspace_name` only titled it), so omitting it did not
put the children in the parent's workspace. A manager also could not start a further run in its own workspace: its own
run had no isolation, and a run without isolation edits the workspace checkout that isolated runs' guard watches, so the
workspace admits one such run and nothing beside it.

## Decision

- A new block on the fan-out step: `workspace: { in: new | parent }`, default `new` (unchanged). With `in: parent` each
  child run starts in the parent run's workspace, in its own run worktree, with the parent link and no new workspace.
  The child's Playbook Manager is created in the parent's workspace.
- The loader requires `isolation: worktree` on both the child playbook and the parent playbook, and refuses
  `workspace_name` together with `in: parent`.
- The workspace rule itself is unchanged: for a manager to start more runs in its own workspace, its playbook has
  `isolation: worktree`, and it calls `start_playbook` with its `workspaceId` and no `newWorkspace`.
- The fan-out node in the run graph shows its progress on its own line, so it is not cut off after the playbook name.

## Consequences

- The default stays `new`, so existing playbooks keep their behaviour; nothing is renamed.
- A parent playbook that edits the checkout itself must not use `in: parent`: it would trip its children's guard, which
  is why it is required to be isolated too.
