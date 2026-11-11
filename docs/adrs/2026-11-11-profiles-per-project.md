# Profile activation is per project, with a Profiles tab

Status: Accepted. The rule that `default` is always active and locked is superseded by `2026-11-11-default-repository-toggle.md`.

Supersedes the activation part of `2026-11-11-profiles.md` (the global `profiles.active`, the RPC's
input and the panel's checkbox bar). Everything else in that ADR stands.

## Context

A global activation list meant that turning a profile on for one repository turned it on for all of
them, and that the panel's checkboxes looked per workspace while changing a global setting. Profiles
live in a project's repository, so the choice belongs to the project.

## Decision

- **Per project, in the user config.** `$PASEO_HOME/plugin-data/paseo-playbooks/config.yaml` holds
  `profiles: { projects: { <project id>: { active: [ids] } } }`. The project is the one Paseo reports
  for a workspace (`projectId`). The setting applies to every conversation of every workspace of the
  project (runs, panels, agent tools). A project with no entry has no profile active; `default` is never
  listed; unknown, non-string or repeated ids are ignored. The old global `profiles.active` is ignored
  (not migrated): users turn profiles on again per project.
- **Source of truth for what is on offer.** The profiles of a project are discovered in its main
  checkout (project root), the same list for all its workspaces. A workspace still loads the playbooks of
  the active profiles from its own checkout (so a branch can change them); an active id without a folder
  there is silently ignored.
- **RPCs.** `playbooks.set-profile` takes `{ projectId, profile, active }` (was `{ profile, active }`).
  New `playbooks.list-profiles` takes projects (each given by one workspace) and returns their profiles
  with the active flags. `playbooks.list` also returns `projectId`, and its `profiles` come from the
  project root. `loadPlaybooks` takes `projectId`; without it (and without `activeProfiles`) no profile is
  active.
- **UI.** A "Profiles" tab on the Playbooks screen (beside Runs and Analytics): one row per project with
  a multi-select dropdown (a checkbox per profile; the active ones shown as chips; `default` always shown
  as active and locked). The Playbooks panel's bar is the same dropdown for the panel's project, bound to
  the project-wide setting. A change refreshes every view in the client at once; other clients and
  workspaces pick it up on their next poll (30 s).

## Consequences

- Profiles can differ between projects, and a change in one place shows everywhere for that project.
- Users of the first profiles release must re-activate their profiles once.
- Runs already started keep their resolved playbook; only later loads see the new setting.
