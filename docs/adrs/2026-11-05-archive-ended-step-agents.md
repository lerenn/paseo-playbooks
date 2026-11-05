# Archive the agents of steps that end without completing

Status: Accepted

Supersedes the "a run that fails or is canceled keeps the agents of its unfinished steps"
point of [2026-11-05-archive-done-step-agents](2026-11-05-archive-done-step-agents.md); the
rest of that decision stands.

## Context

The first version archived a step's agents only when the step completed, or when a new
attempt started. A step that fails the run (`fail`, or no retries left), and the steps a
canceled or failed run cuts short, kept their agents: idle, each still holding a Claude
session and its MCP servers.

Nothing uses them again. `nudge_step` refuses a step that is no longer live, and a restart
starts a new attempt with a new agent.

## Decision

- When a flow ends (the run completes, fails or is canceled, or an after-task ends), the
  plugin archives the agents of its steps that did not complete: failed, canceled, or left
  `reported` or pending with earlier attempts.
- Archiving replaces stopping for these agents (archiving ends the session).
- `archive_agents: false` still keeps them.
- The Playbook Manager is not archived: archiving it archives its runs, which would hide
  finished runs from the Playbooks screen.

## Consequences

- A failed or canceled run no longer leaves idle step agents on the daemon.
- Their conversations stay reachable from the step sheet, as archived agents.
- Managers of finished runs still stay alive until someone archives them.
