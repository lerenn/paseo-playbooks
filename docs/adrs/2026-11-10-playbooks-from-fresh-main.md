# Isolated runs read their playbook from a fresh origin/base, not the workspace checkout

Status: Accepted

Refines `2026-11-09-isolation-worktree.md` (it is not superseded).

## Context

A run freezes the playbook definition (and roles) of the workspace's shared checkout at start. New rules merged to
origin/main therefore reached new runs only after someone fast-forwarded that checkout, which is forbidden while any
isolated run is active (the isolation guard fails running steps when the workspace `HEAD` changes). Coordinators were
blocked ("cannot ff while OPS-490 and OPS-493 are active").

## Decision

- `start_playbook` finds the playbook in the workspace checkout as before (it decides whether the run is isolated).
  When it is `isolation: worktree`, the plugin creates the run's worktree off a freshly fetched `origin/<base>`
  (`isolation.base`, else the default branch), then loads the playbook and roles **from that worktree** and uses that
  definition for the run. The workspace checkout is not touched.
- **Fallback** to the workspace checkout's definition, never silently: the fetch failed (even if a stale
  `origin/<base>` exists); the playbook is missing, invalid, no longer isolated or a singleton on the fresh ref. The
  reason is recorded in `run.definition` (`source: origin | workspace`, `ref`, `sha`, `note`; null on non-isolated and
  older runs), shown by `list_runs`/`get_run`, and `start_playbook` prints it (a WARNING when it is the fallback).
- The definition stays frozen for the run; `restart_run` reuses it. Worktree creation settings
  (`submodules`, `base`) come from the workspace definition, since the worktree exists before the fresh one is read.
- `validate_playbooks` validates what a new run would load: for each isolated playbook, origin's copy (fetched, read
  with `git archive` of the playbook folders, no checkout), else the workspace's; each result carries `source`, `ref`
  and a `note` for fallbacks or an invalid fresh copy.
- Unchanged: non-isolated playbooks and singletons (their pipeline workspace logic), `list_playbooks`, the panel's
  playbook list, and which playbooks can be started: one must exist, valid and isolated, in the workspace checkout.

## Consequences

- New rules reach the next isolated run as soon as they are on origin; the workspace checkout may stay behind.
- A fresh copy that is broken on origin falls back to an older workspace copy (with a note) instead of failing the run.
- `Run` gains an optional `definition` field; older run files load.
- Brand-new isolated playbooks still need to reach the workspace checkout once before they can be started.
