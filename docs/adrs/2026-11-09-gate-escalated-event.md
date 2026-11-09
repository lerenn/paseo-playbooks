# Gate escalated event

Status: Accepted

## Context

`gate.opened` says a role- or manager-held gate is "not waiting for a human yet". An agent that
watches for a human to answer (see `2026-11-09-oversight-tools-and-event-subscriptions.md`) then
never learns that such a gate later became one: the role escalated, failed, or the manager chose
to ask. `list_gates` shows it only when polled.

## Decision

- A new event type `gate.escalated` on the generic bus (it extends the earlier ADR; no new concept,
  no "general manager"). Emitted once per gate when a gate held by the manager or a role decider
  turns to "waiting for a human": the role calls `report_gate_decision` with `escalate`, ends its
  turn without a decision after the reminder, fails to start, or is archived or lost in a daemon
  restart; or the manager escalates.
- The plugin cannot see a manager asking a human in chat, so the manager gets one tool,
  `escalate_gate { runId, stepId, reason }`, to call right before it asks. It is refused on a gate
  whose decider is not the manager, and records the same state a role's escalation does
  (`gate.escalated` reason, now also `escalatedAt`). A manager that asks without calling it
  leaves no event; the manager protocol and the SKILL tell it to call it.
- Payload: the gate payload (`runId`, `playbook`, `runName`, `workspaceDir`, `gateId`, `stepId`,
  `kind`, `question`, `choices`, `deciderBy`, `heldBy`, `roleDeciding`) plus `heldBefore`
  (`manager` | `role`), `heldBeforeRole` (the role id, or null), `reason` (the decider's comment or
  the failure cause), `escalatedAt` and `waitingForHuman: true`. Its text line carries the reason,
  the question, the choices and the tools to call (`list_gates`, `get_run`).
- It follows the same rules as the other gate events: globs (`gate.*`), payload filters
  (`deciderBy`, `playbook`, `runId`...), debounce and `list_events` catch-up. The deciding agent
  that escalated (the role's agent, or the manager) is an actor and never gets it back.
- `gate.opened` is unchanged: a gate that opens waiting for a human emits only that, no
  `gate.escalated`. The producer remembers emitted escalations through the log, so a restart does
  not repeat them; gates escalated by an earlier version (no `escalatedAt`) are not announced.
- `list_gates` shows an escalated gate with `waitingForHuman: true`, `escalatedAt` and
  `escalationReason` (null otherwise).

## Consequences

- A watcher can subscribe to `gate.opened` and `gate.escalated` and know when a human is needed,
  without polling.
- The gate schema gains `escalatedAt` (defaults to null); the manager tool list gains
  `escalate_gate`.
- As with the other events, detection is the 2-second scan; an escalation decided in the same
  window is still emitted, before `gate.decided`.
