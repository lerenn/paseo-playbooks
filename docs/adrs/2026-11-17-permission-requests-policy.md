# Tool permission requests of run agents: `permissions.on_request`

## Status

Accepted

## Context

Run agents (the Playbook Manager, step agents, role deciders and their subagents) normally run in Bypass mode. Claude Code
still raises a Paseo tool permission request for some shell commands that look compound or destructive (for example
`cd <dir> && sed -i ... && gh pr view ... ; rm -rf .tmp/*`). The request sits on the agent and never reaches a human: the
run hangs silently. The plugin only counted such an agent as busy (`stale-sessions.ts`) and dismissed a manager's open
questions; nothing answered a tool request. A fix per user (settings, hooks) would leave most users exposed.

## Decision

- Setting `permissions: { on_request: authorize | escalate | deny }`, a block. Repo-wide in `defaults/main.yaml`, overridable
  per playbook (same block shape, like `workspace` or `isolation`). Not per step: the policy is a trust choice for a run. Default `authorize`.
- Detection is event-driven: the daemon's `agent.permission_requested` and `agent.permission_resolved` hooks. Reconcile
  (start-up) sweeps the agents of active runs once for requests raised while the plugin was away, and the existing 2 s event scan
  checks open permission gates (only when there is one) to close those whose request is gone. No new poll loop. An agent with a
  pending permission still counts as busy for stale-session reloads.
- Scope: an agent that belongs to an active run: manager, step and after-task agents, role deciders and gate chats, and any
  subagent of those (parent chain). Only `kind: tool` requests. Questions, plans and mode changes stay with the human (gate chat
  relies on questions). Agents outside the runs (the Sidekick, a coordinator) are untouched.
- `authorize`: the plugin answers `allow`. `deny`: it answers `deny` with a message telling the agent to pick another way.
  `escalate`: a gate of the new kind `permission` opens on the run, a human gate like the others (`decider: human`,
  choices `allow` / `deny`, agent and command in its text; on the agent's step, or `manager`). It appears in the panel,
  `list_gates`, `gate.opened` / `gate.decided`, makes the run `waiting_gate` and counts as waiting for a human. Deciding it (panel,
  or `resume_gate` with the human's answer) makes the plugin answer the agent; a manager or role cannot decide it. If the request
  disappears (answered in the daemon, agent canceled, archived, session reloaded) the gate closes as `dismissed`, `decidedBy:
  "plugin policy (permissions.on_request)"`.
- Audit: every outcome is a run history entry (`permission_authorized`, `permission_denied`, `permission_escalated`, and the
  answer to an escalated gate), naming the agent, the tool and the command, with `plugin policy (permissions.on_request)` or the
  human who decided. No new field on existing events.
- Fewer requests at the source: the manager protocol and the step prompts ask for simple separate commands, no
  `cd && sed -i && rm -rf` chains, no `rm -rf` globs, and the file tools for edits; the skill gives the same advice to authors.

## Consequences

- Default `authorize` trades strictness for runs that do not hang. It is consistent with the playbook author's and the human's
  earlier choice: an agent running in Bypass mode is one the human already authorized to run commands unprompted, and the
  extra request is Claude Code's heuristic, not a new decision. The risk is that a command the heuristic flagged for good reason
  runs. Users who want a check set `escalate` (a human decides each request, at the cost of interruptions) or `deny` (the agent
  must find another way).
- A new gate kind (`permission`) in run state, `list_gates` and the events; older run files load (the `permission` field is optional, the
  playbook's `permissions` defaults to `authorize`).
- Agents in a non-Bypass mode (`default`, `plan`) also have their tool requests answered by the policy: authors who want those
  asked should set `escalate` in that playbook.
- Not live-tested against a real daemon in this change: tests use a fake daemon API.
