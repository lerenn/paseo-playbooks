# Human gates of a run with no manager are also asked in the step agent's conversation

## Status

Accepted. Builds on `2026-11-12-manager-mode.md`.

## Context

With `manager: { mode: none }` there is no manager to ask the human in chat when a human gate opens (`2026-11-04-gate-question-in-chat.md`). The gate shows in the panel only, and a human working in the step agent's conversation has no question to answer there.

The step agents of such a run are already top-level agents of the run's workspace (decided in the manager-mode ADR, so no separate decision is needed for that).

## Decision

1. When a human gate opens on a run with no manager (a human gate step, an ask, a loop-limit gate, or a role gate that was escalated) and the step agent that precedes it is alive (not archived, idle), the plugin sends that agent a prompt: ask the human with `AskUserQuestion` (one option per choice), then call `answer_gate`. The agent is the owner of an ask gate's step, else the most recent agent of the gate step's `needs`. A busy agent is asked when its turn ends; with none alive, the panel is the only surface. A done step's agent is archived by default, so a playbook that wants the conversation sets `role: { archive_agents: false }` on that step.
2. The step agents of such runs get a new tool, `answer_gate` (`gateId`, `decision`, `comment`), only in manager-less runs, and only the agent that was asked may answer. It records the decision as `via: chat` (`engine.decideGate`, the same checks as the panel and `resume`). `always_on` runs and their agents are unchanged.
3. Either surface closes the gate. The gate records `chatAgentId` (the agent asked) and `chatClosed` (new optional fields on a gate; older runs load). If the panel (or a cancel) closes it first, the plugin denies the agent's open question with "closed in the Playbooks panel, do not call answer_gate, end your turn"; a later `answer_gate` returns "already decided" and changes nothing. If the agent answers first, the panel shows the gate as decided; a late panel decision is "already decided". The panel marks a pending gate that was asked in a conversation.
4. The Sidekick gate sweep and the `gate.opened`, `gate.escalated` and `gate.decided` events are unchanged.

## Consequences

- A human can answer a gate where they already read the work, without the panel.
- The agent's turn is borrowed for the question; it does nothing else. An agent that ignores the prompt leaves the gate open in the panel.
- Not done: a role gate's decider is not asked this way (it is an agent already), and a manager-less run with an archived preceding agent has no conversation surface.
