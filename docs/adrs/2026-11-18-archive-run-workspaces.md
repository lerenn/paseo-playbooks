# Archive the workspaces of archived and ended runs by default

## Status

Accepted. Supersedes the "default false" point (2) of `2026-11-17-archive-workspace-with-run.md`; the rest of that
decision stands. Relates to `2026-11-18-sidekick-subagent-workspace-archive.md`, which keeps archiving the hidden
subagent workspaces about 10 minutes after they finish.

## Context

`archive_with_run` was opt-in, and nothing archived the workspace of a run that was never archived. Workspaces of
archived and ended runs piled up in the Paseo panel and on disk (about 15 stale ones).

## Decision

1. `workspace.archive_with_run` now defaults to **true** (`false` opts out, in `defaults/main.yaml` or a playbook).
2. New `workspace.archive_after`, default `6h` (a duration, or `never`): the workspace of a run that ended `completed`
   or `canceled`, with no after-task running, is archived that long after it ended. The run itself stays visible.
   A `failed` run keeps its workspace until it is archived explicitly (`archive_run` or the panel).
3. Both paths archive only a workspace the run created itself (`workspaceCreated`): never the project checkout, never a
   workspace a user made. They keep it, with a `workspace_kept` history entry and a log line, when the workspace has
   uncommitted changes (untracked files included) or a local commit that no remote has, when another run still uses it
   (active for the timed path, not archived for the explicit path), when an agent runs or waits on a permission, or
   when it holds an agent that is not a run's. The timed path records a refusal once and does not retry; archiving the
   run later tries again.
4. Hidden Sidekick subagent workspaces are unchanged.

## Consequences

- Behaviour change for everyone on upgrade: stale workspaces of ended runs go away on their own. Set
  `workspace: { archive_with_run: false, archive_after: never }` to keep the old behaviour.
- `playbook.workspace` gains `archiveAfterMs` (null = never; old runs load with null, so they are not swept).
- Runs started in an existing workspace (`newWorkspace` unset) are never archived by the plugin.
