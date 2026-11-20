# Warden `stale_definition` waits for the pin to age

## Status

Accepted. Refines [the warden](2026-11-18-warden.md).

## Context

`stale_definition` fired on every cooldown for a healthy run pinned to an older `origin/<base>`:
any push to the base branch made every active run "stale", which is noise.

## Decision

- New field `warden.checks.stale_definition.after` (default `12h`). A run pinned to an origin
  commit is reported only once the pin is that old. The definition is pinned when the run starts,
  so the age is the run's age.
- A definition read from the workspace checkout (origin could not supply it) is still reported at once:
  it is a standing fallback, not drift.
- Not done: reporting sooner when origin changed a file the run's steps use. The run records only
  a commit, not which files its steps and scripts came from, so a robust answer needs a diff of
  the playbook, its sub-playbooks, roles and scripts between two commits on every pass. Only the age rule ships.

## Consequences

- Fewer findings on healthy runs; a run on a stale pin over 12h is reported as before.
- Older run snapshots load with the default (`12h`).
