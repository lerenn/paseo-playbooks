# The Sidekick is given start_playbook and list_playbooks

## Status

Accepted. Decision 4 (runs always start in a new workspace) is partly superseded by `2026-11-13-isolated-start-in-caller-workspace.md` for playbooks with worktree isolation.

## Context

`2026-11-11-sidekick-start-playbooks.md` preapproved `start_playbook` and `list_playbooks` for the Sidekick and wrote its prompt around them, but the `agent.session_open` hook gave a Sidekick only the common tools and `sidekick_handoff`. `start_playbook` and `list_playbooks` are manager tools, so the Sidekick never had them: it reported "start_playbook isn't available in this session" and told the human to start the run from the panel. The preapproval list also left out `record_followup`, `requeue_job` and `start_after_task`, which the Sidekick does have, so each would have prompted for permission.

## Decision

1. The hook gives a Sidekick `list_playbooks` and `start_playbook` (`sidekickStartTools`), taken from the manager tools, with all their inputs (`workspaceId`, `newWorkspace`, `forJob`, `autoStart`). It gets no other manager tool: it manages no run, so `settle_job`, `start_step`, `complete_step` and the rest stay out.
2. `record_followup`, `requeue_job` and `start_after_task` are added to `SIDEKICK_PLUGIN_TOOLS`.
3. A test checks that every plugin tool the Sidekick is preapproved for is one it is given.

## Consequences

- A Sidekick already running keeps its old tool list until its session is reopened: restart it with the column's restart button (or its hand-off restart) after the plugin update.
- The tool contract is unchanged; no playbook format change.

## Decision (added: runs always start in a new workspace; partly superseded by `2026-11-13-isolated-start-in-caller-workspace.md` for playbooks with worktree isolation)

4. **`start_playbook` always starts the run in a NEW workspace**, for every caller (Sidekick, managers, any agent), with its own Playbook Manager; the caller does not manage it. `newWorkspace` is optional and true in effect: `newWorkspace: false` is refused. `workspaceId` no longer selects a workspace to run in: it only names the workspace the new one is branched off. A Sidekick may omit it: the base is its own hidden workspace, which is the project's root checkout, so the call needs nothing from the caller's workspace beyond that (if it is gone, the error asks for `workspaceId`). `forJob` is always satisfiable. This supersedes the "run starts in that workspace" and "own hidden workspace is refused" parts of `2026-11-11-sidekick-start-playbooks.md`, and `start_playbook` creating the run in the caller's workspace.
5. **One exception:** a Playbook Manager the plugin created for a run (a workspace with a reservation) creates that run in its own reserved workspace by calling `start_playbook` with no workspace arguments, as its kickoff says. Without that the panel's "Start" button and fan-out children could not work. Tool contract change: minor version.

Consequences: an agent that used to call `start_playbook` to run a playbook in its own workspace now gets a new workspace and no longer manages the run. Handing a run to an existing agent stays available from the panel.
