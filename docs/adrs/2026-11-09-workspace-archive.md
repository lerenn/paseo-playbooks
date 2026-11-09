# Archive the workspace a run created, when the run ends

Status: Accepted

## Context

Every `start_playbook(newWorkspace: true)` creates a Paseo worktree workspace that nothing
archives: they pile up in `~/.paseo/worktrees` and the sidebar.

## Decision

- New block `workspace: { archive: never | on_end, keep_failed: true }`, in `defaults/main.yaml`
  and per playbook (the playbook wins). Defaults: `never`, `true`: nothing changes for others.
- `on_end` covers runs that complete or are canceled; a fire-and-forget hand-off completes the
  run at hand-off, so a separate `on_handoff` would be the same thing and is not added.
  A failed or manager-lost run is kept while `keep_failed` is true.
- The plugin archives with `workspaces.ref(id).archive()` (programmatic, no agent involved),
  only when all hold: the run has `workspaceCreated` (set by `newWorkspace`, cleared when
  `restart_run` moves the run); every non-archived agent of the workspace is the plugin's (a
  manager, or a step or decider agent labelled with a run of that workspace); no agent is
  running; no gate is pending; no other run of the workspace is active; it is not a pipeline
  or train. While an agent runs or another run is active the check repeats later.
- Otherwise the run gets a `workspace_kept` history entry with the reason and
  `workspaceArchive: skipped`; success is `workspace_archived` and `done`. The run never fails.
- The check runs in the plugin's tick and after each turn end.

## Consequences

- New run fields `workspaceCreated`, `workspaceArchive` (defaulted; older runs load).
  `Playbook.workspace` is added to the snapshot.
- A skipped workspace is not retried (except the "wait" cases); archive it by hand.
