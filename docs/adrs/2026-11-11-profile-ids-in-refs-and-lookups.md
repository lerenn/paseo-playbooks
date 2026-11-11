# Profile ids in git refs, and stored bare ids

## Status

Accepted. Addendum to `2026-11-11-profiles.md`.

## Context

With a profile active, playbook ids are namespaced (`lfradin:pr-to-prod`). A colon is not valid in a git ref, so
`git worktree add -b playbooks/lfradin:pr-to-prod-<run>` failed for every isolated run. Hand-offs, restarts and
singleton refreshes also looked playbooks up by exact id, so a run that stored a bare id (`release_trains`) could not
find its now-namespaced playbook.

## Decision

- Branch names built from a playbook id (isolated worktrees, singleton and new-workspace branches) go through
  `worktreeBranch`, which replaces every character outside `[A-Za-z0-9._-]` with `-` (`playbooks/lfradin-pr-to-prod-78be66`).
  The run id suffix keeps the branch unique.
- Every lookup of a stored or typed playbook id (hand-off, start, restart, singleton refresh) uses `findEntry`:
  a bare id resolves to the unique entry of any repository, a qualified id matches `repo:id`; an ambiguous bare id is refused.

## Consequences

Old runs with bare ids keep working after a profile is activated. Two ids that sanitize alike get different branches
thanks to the run id.
