# A gate decision's comment is feedback for the `goto` target, whoever decides

Status: Accepted

## Context

Findings of a looping outcome reach the target step as "Feedback to address". A decision
comment did not always: approving a loop-limit gate sent the step's summary and dropped the
comment whenever the step had one, and the manager or a role decider (see
`2026-11-07-gate-decider.md`) was not told apart from a human in an `ask`'s feedback.

## Decision

- Every decision that leads to a `goto` passes its comment to the target as feedback: a gate
  step's `goto`, an `ask` (with or without `choices`) and an approved loop-limit gate.
- A human's comment stays as written (`The human answered "<id>": …` for an `ask` with
  choices). A manager's or role's reads `the manager decided: …` / `the role "x" decided: …`
  (`… answered "<id>": …` for an `ask` with choices).
- Approving a loop-limit gate sends the step's last feedback, then
  `On the loop limit, <who> said: <comment>`. Without a comment only the step's feedback.
- No run-state change.

## Consequences

- Same behaviour for panel, chat, manager and role decisions; the target knows who decided.
- Text change only, so a prompt that matched the old loop-limit feedback sees more text.
