# The default repository can be turned off per project

Status: Accepted

Supersedes the rule in `2026-11-11-profiles.md` and `2026-11-11-profiles-per-project.md` that the
`default` repository is always active, never configurable and shown locked.

## Context

Some projects want only a profile's playbooks, without the shared catalog in the project's own
`.paseo/plugins/playbooks/` folder. The lock left no way to hide it.

## Decision

- **On unless turned off, per project.** `profiles.projects.<project id>.default: false` in the user
  config turns the project's default repository off. Absent (or anything but `false`) means on, so
  existing users and projects without an entry see no change. Turning it back on removes the key.
  `default` still never appears in the `active` list.
- **Effect.** When off, the default repository's playbooks, roles and defaults (both the primary and
  the legacy folder) are not loaded: its playbooks leave the catalog, the panel and the agent tools.
  Active profiles are unaffected and still resolve only their own resources. Runs already started keep
  their resolved playbook. The Sidekick (`sidekick/`) is read separately and is not affected.
- **RPCs.** `playbooks.set-profile` accepts `profile: "default"` (it was a no-op). The repositories
  offered (`playbooks.list`, `playbooks.list-profiles`) now list `default` first as a `ProfileInfo`
  with its playbook count and active flag. `LoadResult` gains `defaultActive`; `loadPlaybooks` takes an
  optional `defaultActive` override.
- **UI.** `default` is a normal checkbox row in the dropdown (Profiles tab and panel bar), a chip when
  active. The panel bar stays hidden only while the project has no profile and default is on.

## Consequences

- A project can run on profiles alone; with everything off it has an empty catalog.
- Anything loading playbooks with a `projectId` follows the setting; callers without one still load default.
