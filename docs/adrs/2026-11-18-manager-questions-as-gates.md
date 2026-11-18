# Manager questions as gates (`manager_question`)

## Status

Accepted

## Context

A Playbook Manager that asks the human a question in its own conversation (AskUserQuestion) is blocked on it, yet the run has
no gate for it: the main Playbooks panel shows no "Needs you" entry and `list_gates` is empty, so the human only finds it by
opening the manager's conversation. `manager.question_pending` (ADR 2026-11-18-manager-waiting-watchdog) announces it to a
Sidekick after a delay, but the panel stays blind. Tool permission requests of run agents already become `permission` gates under
`permissions.on_request: escalate` (ADR 2026-11-17-permission-requests-policy); questions were left to the human on purpose
(gate chat relies on them, ADR 2026-11-04-gate-question-in-chat).

## Decision

- A real gate, not a derived list: a gate of the new kind `manager_question` on the pseudo-step `manager`, a human gate
  (`decider: human`). It reuses the `permission` gate's machinery (the `permission` field holds `agentId`, `requestId`, `tool`;
  the daemon's `agent.permission_requested` / `agent.permission_resolved` hooks, the restart sweep and the 2 s scan that closes
  a gate whose request is gone). So the panel's "Needs you", `list_gates`, `gate.opened` / `gate.decided`, `waiting_gate`,
  "needs input" and `resume_gate` work unchanged. A new gate field `question` holds the text, the options and `answerable`.
- Opened for `kind: question` requests of the manager itself (not a step agent or a subagent; run active and not paused). Not
  opened while the run has a gate step, ask or loop-limit gate held by a human: the manager is then asking that gate's question
  in chat (ADR 2026-11-04) and the gate already shows it. A tool request is never a question gate, so under `escalate` the
  `permission` gate and this one never describe the same request; under `authorize` / `deny` the plugin answers a tool request at once.
- Choices come from the question: `option-N` (the option's label as the button), `other` ("Something else", comment required, the
  typed text is the answer); a question without options has `answered` (comment required). A request with several questions or a
  multi-select is `answerable: false`: listed with all its text, no choices, answered in the manager's conversation (the run's
  manager button opens it).
- Deciding (panel, or `resume_gate` by an agent outside the runs; never the manager) calls the daemon's `respondToPermission` with
  `allow` and `updatedInput.answers` keyed by the question text. The first answer wins: if the conversation answered meanwhile the
  daemon refuses the second delivery (logged) and the resolved hook closes the gate as `dismissed`; a decided gate answers once.
- History entries `manager_question_opened` and `manager_question_answered`. No setting: it only surfaces what is already
  waiting; the Sidekick stays optional.

## Consequences

- The human sees and answers a manager's question from the panel, without opening the conversation; Sidekicks see it in `list_gates`.
- A new gate kind and an optional gate field (older run files load). Consumers that switch on `kind` see `manager_question`
  (`gate.opened` payload kind included).
- A pending question gate puts the run in `waiting_gate`, like a `permission` gate; the manager watchdog does not prompt a manager
  that is blocked on it.
- Multi-question and multi-select requests are not answerable from the panel: they are visible, not answerable.
- Not live-tested against a real daemon: the answer shape follows Paseo's Claude provider (`updatedInput.answers` keyed by question
  text); tests use a fake daemon API.
