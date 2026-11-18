# `refresh_scripts` works on a failed run, with an explicit source; a workspace-checkout definition is a visible warning

## Status

Accepted

Changes one rule of `2026-11-13-refresh-run-scripts.md` ("refused for a run that ended"); that ADR stays
Accepted for the rest, and is not superseded. Refines `2026-11-10-playbooks-from-fresh-main.md`
(the fallback to the workspace checkout is no longer quiet).

## Context

A failed run keeps its pinned scripts and definition: its worktree is kept for a while with the old scripts, and
`restart_run` reuses the pinned definition. After the bug was fixed on main, `refresh_scripts` refused the run ("has ended")
and could be called only on an active run, i.e. too late: the restart failed again within seconds (for example on an
output the pinned step did not declare). Separately, when a playbook is invalid on origin (a value over a size limit, say),
a new run silently pins the workspace checkout's copy, which may be stale; the reason was only in `definition.note`.

## Decision

- `refresh_scripts` accepts an ended run that `restart_run` could reopen (the same rules: not a singleton pipeline or a
  batch, some step restartable, no after-task running). On such a run it also re-reads the definition (playbook, roles,
  defaults) from the same source, and replaces the pinned one when its steps are the same (ids, kinds, needs, after-task
  membership); otherwise the definition stays pinned and the result says why. History, outputs and completed steps are kept.
  An active run is unchanged: scripts only, definition pinned. The scripts of an ended run still never run by themselves:
  only `restart_run` runs them.
- The source is explicit in the result (`source`, `ref`, `definition`, `note`): `origin/<branch>` when the playbook there
  is valid; when it is invalid, missing or no longer isolated, the workspace checkout (scripts and definition), with the
  short validation error in `note` and the run's warning. A failed fetch is still a refusal.
- `restart_run` takes `refresh: true` (default false): `refresh_scripts` first, then the restart; when the refresh fails
  nothing is restarted. Without it `restart_run` keeps reusing the pinned scripts and definition.
- A run whose definition was read from the workspace checkout instead of origin carries a warning
  ("definition read from the workspace checkout because origin/<branch> is invalid: <reason>"): `run.definition.warning`
  and `warnings` in `get_run`/`list_runs`, a `definition_fallback` history entry, a `run.definition_fallback` bus event
  (at start and at a refresh), and a line in the run's details in the Playbooks panel.
- Additive and optional: `run.definition.warning` and `run.scripts.source` default when absent, so stored runs load
  unchanged and older runs simply have no warning. No migration.

## Consequences

- A failed run is fixed with one call (`restart_run` with `refresh: true`), or `refresh_scripts` then `restart_run`.
- A refreshed ended run can pick up a changed output contract, since the definition is re-read; a change of the step
  graph still needs a new run (the definition is kept, the scripts refreshed, and the result says so).
- The refresh copy of a failed run is removed with its worktree, so refresh right before restarting (or use `refresh: true`).
- A stale workspace fallback is now visible to the run's reader and to subscribers, not just in a note.
