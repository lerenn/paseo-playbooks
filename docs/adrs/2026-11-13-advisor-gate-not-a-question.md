# A gate still with its advisor is not a question for a human

## Status

Accepted

## Context

A gate whose decider is a role (the advisor) is decided by an agent the plugin starts; it reaches a
human only if that agent escalates. The server already counted such gates out of "needs you"
(`waitsForHuman`), but the UI listed every pending gate as a "Decide" row in Needs you, in the
header counter and the chips, and showed the Decide buttons on the step.

## Decision

- Every UI surface that asks a human something uses `waitsForHuman` (`shared/gates.ts`): the Needs you
  list, the "needs you" counter, the chips, the fan-out lane marker, the graph's choices.
- Until the advisor escalates, the step shows only a neutral, non-actionable "Advisor deciding"
  line (graph node and step sheet), with no choices. This supersedes the line of
  `2026-11-07-gate-decider.md` that a human can always decide first in the panel, for role deciders.
- Once escalated, the gate is a human gate as before. Manager-decided gates are unchanged: the manager
  may ask a human without the plugin seeing it, so they still count.
- `get_run` gates carry `waitingForHuman`, matching `list_gates` (additive field).

## Consequences

- A human no longer overrides an advisor mid-decision; cancelling the run is the remaining way.
- UI, counters, notifications and agent tools agree on what needs a human.
