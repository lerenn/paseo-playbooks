# One Sidekick per project, defined by a `sidekick/` folder

Status: Accepted

Supersedes `2026-11-10-sidekick.md`. Refines `2026-11-10-sidekick-chat-column.md` (the column stays; it gets tabs).

## Context

The first Sidekick was one agent for the whole host, in an empty hidden directory, with a prompt of its own.
That does not match the plugin's model: playbooks, roles and defaults belong to a repository, are versioned
with it and reviewed in pull requests. A host-wide Sidekick reads the configuration of no repository, cannot
see a project's files, and has nothing a team can share.

## Decision

- **One Sidekick per project.** It is defined by a `sidekick/` folder inside the playbooks folder, beside
  `roles/` and `defaults/`: `sidekick/sidekick.yaml` with `sidekick: { provider, model, mode, thinking,
  watch }` (all optional, unknown keys are errors) and `sidekick/instructions.md` (the repository's rules,
  appended after the built-in coordinator prompt; when present it must not be empty). A project without a
  `sidekick/` folder has no Sidekick.
- **No clash with playbook ids.** The Sidekick is a folder, so it never takes a playbook id: a playbook
  `sidekick.yaml` in the playbooks folder and `sidekick/sidekick.yaml` coexist. No name is reserved.
- **Where it runs.** In a hidden background workspace (`background: true` only; the host removed public
  `internal` workspaces) whose directory is the project root, so it can read the repository and its
  playbooks. It keeps no shell or file tools (Claude: `Bash`, `Edit`, `Write`, `NotebookEdit` disallowed)
  and sends subagents, created in the project's workspaces, to change anything; they open pull requests that
  a human merges. `sidekick.json` maps `projectId` to `{ workspaceId, agentId }`; the host-wide single record
  of the earlier version is ignored.
- **Events.** On creation the plugin subscribes it to `sidekick.watch` (default `gate.escalated`,
  `run.failed`, `run.manager_lost`), delivery `idle`, filtered to its project: every oversight event payload
  now carries `projectId`, so a subscription can filter on it. Other agent tools (`list_gates`, `list_runs`)
  still list every project's runs; the prompt tells it to act only on its own project's.
- **Tools.** A Sidekick agent gets only the common tools, never a manager's, although its workspace holds
  playbooks.
- **UI.** The Sidekick column of the Playbooks screen has one tab per project that has active runs or an
  already-created Sidekick, and a far-right "+" tab to add another project. A project with no `sidekick/`
  folder shows what a Sidekick is, a guide link, and "Create the Sidekick files", which writes a starter
  `sidekick/` (never overwriting). A project whose files have errors shows them. Opening a tab of a
  configured project creates or reuses its agent.
- **RPCs.** `sidekick.list` (projects with `configured`, `errors`, `agentId`, `activeRuns`), `sidekick.open`
  (by workspace id) and `sidekick.create-files` replace the host-wide `sidekick.open`.
- `validate_playbooks` also reports the Sidekick files' errors.

## Consequences

- The Sidekick is shared and reviewed like the playbooks. There is no host-wide view: a user who wants one
  opens several tabs.
- The agent's directory is the project root, which already has a workspace. If the daemon answers a
  directory workspace request for a path it already knows with that existing workspace, the Sidekick agent
  lands there instead of in a hidden one; this was not verifiable without a running daemon.
- The events payload gains `projectId` (older logged events lack it, so a project filter never matches them).
- Model and mode come from `sidekick.yaml`; there is no per-user setting.
