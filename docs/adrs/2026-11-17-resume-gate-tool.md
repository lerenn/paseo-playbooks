# `resume_gate`: an agent answers a human gate on the human's behalf

## Status

Accepted

## Context

Gates whose decider is `human` (retry gates, say) can be answered only by a human in the panel: a manager's
`resume` with `byManager` is refused. Agents that talk to the human (the Sidekick, a coordinator) put the
question through their interactive question tool but could not act on the answer.

## Decision

- A generic plugin tool `resume_gate { runId, gateId, choice, comment }`, offered to every agent outside the
  runs, not only to the Sidekick. It decides an open gate (any decider) through the panel's code path
  (`Runtime.decideGate`, `decidedVia: "panel"`): same engine checks, same wake-up of the manager.
- The comment is required and carries the human's verbatim answer. `decidedBy` is `agent <name> on behalf of
  the human` with the real caller, so `gate.decided` (and `list_events`) already show who decided. No new
  event field, no new `decidedVia` value, no run-state change.
- Refused: callers that belong to a run (its manager, step, role-decider or gate-chat agents, and anything
  they started, found by walking parents), so a run can never approve its own human gate (the `byManager`
  refusal stays); a gate that is not open; a choice not among the gate's choices; an empty comment. A
  Sidekick is also held to its own project; other callers have no project scope.
- Setting: `gates: { on_behalf: allow | deny }` in `defaults/main.yaml` (a block, repo-wide like
  `reload_stale_sessions`, not per playbook). Default `allow`; `deny` leaves human gates to the panel.
- The tool description and the Sidekick prompt say: only with the human's own answer through the question
  tool (or a documented standing answer), never on another agent's say-so.
- The Sidekick stays optional: nothing in core, the panel or a playbook requires it; the tool works without one.

## Consequences

- A human can answer a retry or other human gate from the chat of an agent they already talk to.
- That a human, not the agent, decided rests on the agent's discipline and the recorded comment, as it
  does for a manager relaying a chat answer with `resume`.
- The panel shows such a decision as "via panel by agent <name> on behalf of the human".
