# `refresh_scripts`: an explicit per-run refresh of the scripts, the step definition stays pinned

## Status

Accepted

## Context

An isolated run pins its playbook, roles and scripts when it starts (a worktree of a freshly
fetched `origin/<base>`, see `2026-11-10-playbooks-from-fresh-main.md`). A fix committed to the
scripts afterwards never reaches a run already in flight: run_36ebcc kept executing a
`codex_check` and a `ci_check` that had been fixed on main (ANY-3143, ANY-3133). The only ways
out were to restart the run, which loses its position, or to edit its worktree by hand.

Reading scripts live from main for every check is unsafe: a newer script can expect inputs, or
write outputs, that the step definition pinned in the run does not declare (the ANY-3143 case).

## Decision

- A new agent tool `refresh_scripts({ runId?, reason })`, defined with the common run tools (managers
  and the Sidekick get it, like `cancel_run`; not a manager-only tool). `runId` defaults like
  `cancel_run`.
- It fetches `origin/<branch>` and copies the run's `<relDir>/scripts/` tree (only that tree) from
  it into `<data>/run-scripts/<runId>`, written aside and renamed into place. Script steps run
  that copy first, then the worktree's, then the workspace's. The step definitions (inputs,
  declared outputs, timeouts, poll) and the rest of the pinned playbook are untouched.
- The copy is recorded on the run (`run.scripts`: sha, dir, refreshedAt; optional, so stored runs
  load unchanged) and in the history (`scripts_refreshed`: sha before and after, reason).
- Refused for a run that ended, has no worktree, whose worktree was not created from
  `origin/<branch>` (no fresh ref), or when the fetch fails. Refreshing twice to the same commit
  reports `changed: false`.
- The copy is removed with the worktree (cleanup, orphan sweep) and with the run (workspace archived).

## Consequences

- One call per in-flight run is needed after a script fix; runs that never ask are unchanged.
- A script whose output contract changed still goes through the pinned declared outputs: such a
  fix needs a new run.
- The history says which script version a check ran.
- It reaches runs only after a plugin release and `paseo plugin update`; runs in flight at the
  update keep their pins until refreshed.
