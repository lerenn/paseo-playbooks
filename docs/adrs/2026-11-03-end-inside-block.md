# `end` inside a sub-playbook ends the block, not the run

Status: Accepted

Refines decision 49 of `2026-11-02-design.md` (sub-playbooks).

## Context

The loader expands a sub-playbook into its parent and copies its `on` transitions. A `goto`
gets the block's prefix, but `end` was copied as is, and the engine treated it as "complete
the run". So a playbook behaved differently depending on where it ran. On its own, `end`
means "this playbook is done". Nested, it ended the whole parent run: `ready: end` in
`babysit` completed a `ticket-to-prod` run before its approve gate and `release` block, and
the release had to be started as a separate run.

## Decision

- `end` (an agent step outcome or a gate choice) inside a block ends only the innermost
  block that contains the step. The step completes. The block's other unfinished steps get a
  new step status, `skipped`: running agents are interrupted and the block's pending gates
  are closed. Then the run goes on with the steps that need the block.
- `skipped` counts as done wherever `completed` did: a step whose `needs` are all completed
  or skipped becomes ready, the run completes when every step is completed or skipped, and a
  block whose steps are all completed or skipped no longer holds its `concurrency` slot.
- The block's outputs resolve from its completed steps. Outputs of skipped steps are absent,
  just as a top-level `end` leaves unreached outputs unset.
- A `goto` that resets skipped steps makes them `pending` again, so a `goto` to an ended
  block runs it again (queueing for a slot like any restart).
- `fail` still fails the whole run. `end` in a top-level playbook still completes the run.
- The panel dims skipped steps, gives them a skip icon and the label "skipped (block ended)". A gate
  button whose choice ends a block reads "→ End <block title>" (`end_block` destination).

## Consequences

- A playbook means the same thing alone and nested, so `ready: end` is safe in a
  sub-playbook again. The workaround of removing it (anyshift-monorepo #270) is no
  longer needed.
- Run state has a new step status. Older plugin versions cannot read runs that contain
  skipped steps. The version is bumped as a minor release.
