# Sidekick: start playbook runs, bulk coordinator, `sidekick.runs`

## Status

Accepted

## Context

A Sidekick could not start a run: it had no `start_playbook` tool (which starts a run in the caller's own workspace, and a Sidekick's own workspace is hidden) and its prompt said never to start one. It also said the human merges every pull request and that it never asks a subagent to. The human wants the Sidekick to start runs, to do bulk work ("do all tickets of project XYZ on Linear"), and to get a pull request merged by the project's merging playbook when they ask.

## Decision

1. **`start_playbook` and `list_playbooks` are preapproved for the Sidekick** (`SIDEKICK_PLUGIN_TOOLS`; `list_workspaces` already was). `start_playbook` gets an optional `workspaceId` input: a workspace of the caller's project in which the run starts, with a new Playbook Manager there; with `newWorkspace` the run starts in a new workspace branched off it. A Sidekick must pass it, and is refused its own hidden workspace and workspaces of other projects. The caller does not manage the run; it follows it through its event subscription and `list_runs`. The path is the one of the panel's "Start" button (`startFromPanel`), so reservations, concurrency and isolation rules are unchanged. A duplicate (same playbook and inputs already active) is refused.
2. **Merging.** The Sidekick still never merges and never asks a plain subagent to. When the human explicitly asks to merge a pull request, it starts the project's merging playbook (for example `pr-to-prod`) with `start_playbook`, and that run's manager merges. This supersedes the "never merge / never ask a subagent to merge" point of the earlier Sidekick ADRs, and only that point; their other decisions stand.
3. **Starting runs.** The "never use create_agent to start a playbook run" rule stays, but runs are now started with `start_playbook`, which replaces "runs are started with a playbook's own manager".
4. **Bulk work** goes to a coordinator subagent (`create_agent`, in a visible workspace of the project, under the existing placement rules). Its prompt tells it to use the MCP tools available to it (Linear, ...) to list the tickets and start one run per ticket with `start_playbook`, then report once. The prompt says the Sidekick has no MCP access of its own.
5. **`sidekick.runs: { max_concurrent, confirm_bulk }`** in `sidekick/sidekick.yaml`, in a block as the format guidelines ask. `max_concurrent` is a positive integer, unset means unlimited; `confirm_bulk` is a boolean, default `false`. Invalid values (zero, negative, fractional, non-boolean, unknown keys) are errors, like the other Sidekick keys. When set, the prompt prints the rule: at most N active runs of the project (counted with `list_runs`), and ask the human with the interactive question tool before launching more than one run in a batch.

## Consequences

- **The limits are enforced by the prompt only.** The plugin does not count runs or block `start_playbook` for a Sidekick; a Sidekick or a coordinator that ignores the prompt can exceed them. Playbook-level `concurrency` is still enforced by the plugin. Defaults are unlimited runs and no confirmation, so a bulk request starts one run per ticket at once.
- **MCP finding.** `create_agent` (`@getpaseo/server`, `paseo-tools.js`, `resolveInheritedProviderConfig`) copies only the caller's `providerOptions` to a same-provider child, not the caller's `config.mcpServers` (which the daemon sets per agent). A Sidekick subagent therefore does not receive MCP servers injected into the Sidekick's own session. It gets Paseo's own tools, and, for Claude, whatever the provider loads from its user and project settings (`~/.claude`, the workspace's `.mcp.json`). Whether Linear is available to the coordinator thus depends on that configuration; nothing is built here to forward servers, and the coordinator is told to report when it has no such tool.
- A Sidekick already running keeps the old prompt and tool list until restarted with the column's restart button.
