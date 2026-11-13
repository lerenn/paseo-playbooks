# Refresh a run's scripts from the base branch

## Status

Accepted.

## Context

A run pins its playbook definition at start, and an isolated run's script steps run the `scripts/` of its worktree, a copy of the base branch as it was then. A script fix merged afterwards (ANY-3143, ANY-3133) never reaches a run already in flight, which keeps running the buggy script until someone restarts it.

## Decision

1. Option (b), chosen by the human: the run keeps its pinned step definition and worktree, and a new explicit action refreshes only its scripts. Running scripts live from `main` (option a) was rejected: a script and the step that declares its inputs and outputs would drift apart on every merge, silently.
2. The `refresh_scripts` agent tool (`Runtime.refreshScripts(runId)`) fetches the run's base branch from origin and exports the `scripts/` of the playbooks folders and of every profile at that commit into an overlay, `<plugin data>/script-overlays/<runId>/`. The worktree is not edited, so nothing stray can reach the run's PR.
3. A script check looks in the overlay first (once `run.scriptsRefresh` is set), then the worktree, then the workspace. A check already running finishes with the old file. `run.playbook` (steps, declared outputs, script names) is never changed: a script the pinned definition does not name is never run.
4. Refusals are explicit: a run without isolation (its scripts already run from the live checkout), an ended or archived run, a worktree that changed a script itself (the scripts are named; `git diff <baseSha>` of the scripts dirs), and a failed fetch (the error is given and the previous scripts stay).
5. The refresh is recorded as a `scripts_refreshed` entry in the run's history (`get_run`) with the pinned and the new commit, and `run.scriptsRefresh` in run state. The overlay survives a daemon restart and is deleted with the run's worktree (cleanup, orphan sweep, deleted workspace).
6. No UI button: that would be a new surface and its own decision.

## Consequences

- A refreshed script may expect inputs or outputs the pinned step does not declare. The tool lists the changed scripts so the manager can judge, and a changed step definition still needs `restart_run`.
- After a refresh the overlay shadows the worktree: a script the run's own branch changes later is not run (the overlay copy is). Refreshing again re-exports from the base branch; a worktree script change made before the refresh is refused, one made after is ignored until the overlay is dropped (restart the run).
- A refreshed script runs from the overlay, so `$0`-relative paths that reach outside `scripts/` (for example `$(dirname "$0")/../x`) resolve inside the overlay, not the worktree.
- A failed `git diff` of the worktree is a refusal with the git error, never a skipped check.
- Run files from older versions load (`scriptsRefresh` defaults to null). Minor version bump.
