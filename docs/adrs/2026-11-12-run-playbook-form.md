# A Run Playbook form, and `workspaceName` on `start_playbook`

Status: Accepted

## Context

Starting a run in a new workspace was possible only from a playbook card ("Start in a new workspace") or with
`start_playbook` `newWorkspace`, and the workspace was always titled `<playbook title>: <request headline>`. People
wanted to name the workspace, and to start any playbook from one place without finding its card.

## Decision

- New optional `workspaceName` on the `start_playbook` agent tool (valid with `newWorkspace`; refused without it) and on
  the `runs.start` RPC (valid when a new workspace is created; refused with `agentId` or `sameWorkspace`).
- The name is sanitized by `sanitizeWorkspaceName` (control characters and whitespace runs become one space, trimmed,
  at most 80 characters). Empty after that: the default title. It is the workspace title only; the branch stays
  `playbooks/<playbook>-<run id>`.
- New UI surface: a "Run Playbook" button at the top left of the Playbooks panel opens a form (workspace name, playbook
  dropdown, that playbook's inputs, Start at the bottom right). It reuses the start sheet (`StartForm`) with target
  "workspace"; the sheet also gains the workspace name field for "Start in a new workspace". The dropdown lists the
  valid non-singleton playbooks of the panel's workspace (a panel shows one workspace, so one project: no project
  selector). Missing required inputs and start errors show inline; success shows a toast and opens the new workspace.

## Consequences

- No new RPC: the form calls `runs.start`.
- Singletons are not offered: they run as their own pipeline, not in a chosen workspace.
- Names are not required to be unique; the daemon decides what a duplicate title means.
