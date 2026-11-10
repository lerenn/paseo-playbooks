# Branch steps: if / else-if / else on inputs and step outputs

Status: Accepted

Extends `2026-11-06-conditional-steps.md`, which left conditions on step outputs out.

## Specification changes

| Change                       | Where            | Kind | Summary                                                                 |
| ---------------------------- | ---------------- | ---- | ----------------------------------------------------------------------- |
| `branch: { cases: [...] }`   | step kind        | new  | Ordered cases; the first whose `if` holds wins; the last has no `if`    |
| `when` / `if` operands       | step, branch     | changed | Also `steps.<id>.outputs.<name>`, `steps.<id>.outcome`, `{ empty: bool }` |
| `branch` (`RunStep`)         | run state        | new  | The case a branch step took (default `null`)                            |

## Context

`when` tests the run's inputs by equality, and each step is tested alone. A playbook could not say "service PRs go to
the release trains, the others to a merge path or a human, whichever the earlier steps found": the cases overlap and
depend on values a step reports, and `when` has no order, no `else`, and no access to outputs.

## Decision

A **branch step** (`branch:` is its kind block, like `role` or `gate`) lists cases in order. When it is reached it
evaluates them with the engine, no agent, takes the first case whose `if` holds, and completes at once with that
case's name as its outcome (and `state.branch`). Steps of a case put the case in their `when`:

```yaml
- id: route
  needs: [approve]
  branch:
    cases:
      - { name: service, if: { steps.prs.outputs.kind: service } }
      - { name: infra, if: { steps.prs.outputs.kind: [infra, docs], env: prd } }
      - { name: other }                     # the else
- id: trains
  needs: [route]
  when: { steps.route.outcome: service }
  playbook: { name: release_trains }
- id: needs_you
  needs: [route]
  when: { steps.route.outcome: [infra, other] }
  gate: { question: Merge and apply by hand? }
- id: done
  needs: [trains, needs_you]               # the join
```

- **Operands** (also in `when`, so plain steps can test them without a branch): an input of the playbook, or
  `steps.<id>.outputs.<name>`, or `steps.<id>.outcome`. Tests: a value (equality), a list (any of), or
  `{ empty: true }` / `{ empty: false }` (output unset or `""`, or set). Within one `if`, all tests must hold.
  Values are compared as text after being checked against the input's or output's type.
- **Skipped steps do not block**: a step whose `when` does not hold is `skipped`, which counts as done for `needs`, so
  the join `needs` every branch and starts once the one that ran is done. A skipped branch step skips its cases (its
  outcome is unset).
- **Validation** (`validate_playbooks`): a branch without an `else` (last case with an `if`), an `else` that is not
  last (the cases after it can never run), an unreachable case (an earlier case holds whenever it does: the same
  tests, or fewer, with at least its values), duplicate case names, an empty `if`, an unknown step, output or value,
  an outcome that is not one of the step's, and a step that is not an ancestor through `needs` (which also rules out
  cycles). A playbook step has no outcome to test. Not allowed on after-tasks or singleton stations.
- **Reading outputs** is unchanged: a step still reads outputs of a conditional step only with the same `when`.
- **Run state and tools**: `RunStep.branch` (default `null`); `get_run` shows `chosen` for a branch step and the
  `skipped` reason for a skipped one; the history records `step_completed` ("branch service: ...") and `step_skipped`.
  The panel draws a branch as a node with its cases and the one taken, and skipped cases dimmed.

## Consequences

- Additive: `when` on inputs, and `when: { loop }`, behave as before.
- Conditions stay equality, any-of and emptiness: no expression language, no list or numeric comparison.
- A new step kind is added to `Step.kind`; runs from before load unchanged.
