# The Run Playbook button moves to the overview screen

Status: Accepted

## Context

`2026-11-12-run-playbook-form.md` put the "Run Playbook" button in the per-workspace Playbooks tab, shown only when the
workspace had a runnable playbook. People look for it on the overview screen (Runs / Analytics / Profiles), where it was
missing, and it flickered into the tab after the playbooks loaded.

## Decision

- This supersedes only the placement in that ADR (the rest of it, the form, `workspaceName`, stays Accepted). The button
  is removed from the workspace tab; its cards keep "Start in a new workspace" with the workspace name field.
- The button sits in the overview header, next to Sidekick. It is shown when at least one project has a valid
  non-singleton playbook, and disabled (not hidden) while the playbook lists load, so it does not appear late.
- The overview spans projects, so the form gains a project dropdown above the playbook dropdown (projects with a
  runnable playbook). It is preselected to the selected project chip, or to the only candidate; with "All projects" and
  several candidates the human must choose before the form appears. Playbooks are listed (`playbooks.list`) and the run
  started (`runs.start`) from the project's first workspace.

## Consequences

- No new RPC. The overview issues one `playbooks.list` per project (shared query cache with the tab).
- The form code (`RunPlaybookForm`, `StartForm`) is shared; the overview adds `OverviewRunForm`.
