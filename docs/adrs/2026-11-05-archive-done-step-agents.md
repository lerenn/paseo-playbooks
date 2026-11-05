# Archive step agents once the run no longer needs them

Status: Superseded by [2026-11-05-archive-ended-step-agents](2026-11-05-archive-ended-step-agents.md) (agents of unfinished steps)

## Context

A step agent stays alive after its step completes: idle, but still holding its provider
session (Claude and its MCP servers). A run of a few steps, with retries and loops, leaves
many of them. On a shared daemon, dozens of idle step agents filled a 32 GiB pod.

Nothing uses such an agent again. `nudge_step` only reaches a step that is `running` or
`reported`, and a retry, a `goto` or a restart always starts a new attempt with a new agent.

## Decision

- When a step completes (green), the plugin archives the agents of all its attempts.
- When a new attempt of a step starts, the plugin archives the previous attempt's agent.
- A step that is `reported` (waiting for `complete_step`) keeps its agent: the manager may
  still nudge it. A run that fails or is canceled keeps the agents of its unfinished steps.
- A new optional boolean `archive_agents`, on agent steps and in `defaults/main.yaml`,
  turns this off when `false`. Default `true`. It does not apply to gates, script steps or
  playbook steps.
- An agent that is already archived is skipped; a failed archive is logged and ignored.

## Consequences

- Idle step agents no longer pile up on the daemon, and the agent list stays short.
- A completed step's conversation is still reachable from the step sheet, as an archived
  agent.
- Paseo's `agent.archived` hook fires for these agents; the runtime ignores it, since the
  step is completed or the agent is no longer its latest attempt.
- `archive_agents: false` keeps the agents alive, e.g. to debug a playbook.
