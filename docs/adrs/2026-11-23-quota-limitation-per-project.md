# The Quota limitation tab shows the limits resolved per project

Status: Accepted. Refines `2026-11-23-quota-limitation-tab.md` (its "the figures use the user-level limits" rule and the `quota.limitation` input). Its layout is refined by `2026-11-23-quota-limitation-project-rows.md`.

## Context

`quota_limits` is resolved per run from the project's playbooks folder (`2026-11-23-quota-limits-in-defaults.md`: folder defaults, then
user config, then built-in). The tab showed only the user-level limits, so it said "Pacing is off" while a project's
`quota_limits: { quota: { usable_percent: 90 } }` made its runs pace, and its provider cards said "Paced" under that same header.

## Decision

- `quota.limitation` takes `workspaces` (one `{ projectId, workspaceId }` per project, as `sidekick.list` does; the panel sends its
  projects). For each project the server loads its playbooks and resolves the limits like a new run does, one set per distinct result
  among them (a profile's defaults can differ from the default repository's; the repositories of each set are named when there are several).
- The tab opens with a card per project: pacing on or off, usable percent, step cap, run cap. The global top card (one pacing flag,
  one percent) is gone; it keeps the steps running and active runs, which the caps count over all projects, and the runs held by a cap.
- Usage windows and reservations stay global per provider. A window's allowed so far, headroom and free share are listed for each
  distinct `usable_percent` among the projects with pacing on, with those projects named.
- A provider is shown as paced only when some project has pacing on, and names those projects; otherwise "Not paced: no project has
  pacing on" (its raw usage is still shown). The reading's freshness (`state`) is still judged at the user-level settings.
- Strings in en, fr and zh-CN. Without `workspaces` (an older panel) no project is listed and no provider counts as paced.

## Consequences

- The figures match what a new run of each project would be admitted against; a project without `quota_limits` shows the user-level limits.
- The RPC reads each project's playbook files on every poll (30 s), as the panel's definitions query already does.
- Read-only; no change to the playbook format, run state or the agent tools.
