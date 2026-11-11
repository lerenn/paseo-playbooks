# Sidekick runtime: relay, subagent notices, ledger and session restart

Status: Accepted

Extends `2026-11-10-sidekick-per-project.md` (it stays the definition of a Sidekick).

## Context

A Sidekick lives for days. Its context grows without bound (long coordinator sessions reach hundreds of
thousands of tokens and burn the user's token limit), it forgets its decisions at a reset, a subagent's
finish notice can land in the middle of a question to the human, and other agents cannot find it.

## Decision

- **Discovery.** The Sidekick agent carries `playbooks/sidekick=true` and `playbooks/project=<project id>`.
  The plugin knows nothing about any messaging system.
- **Relay.** It may call `respond_to_permission`, `get_analytics` and `sidekick_handoff` unasked. The prompt says
  to relay only the human's answer (the answer to its interactive question), then verify with `get_run`.
- **Subagents.** `sidekick.subagents: { provider, model }` in `sidekick.yaml` (default `claude` /
  `claude-sonnet-5-5`) is named in its prompt, with `notifyOnFinish: false`. The plugin sends it a one-line
  notice when a subagent's turn ends, held until the Sidekick is idle.
- **Ledger.** The new tool `sidekick_handoff { summary, restart? }` (Sidekick only) saves a short ledger in
  `sidekick.json`; any later session of the Sidekick starts from it.
- **Session hygiene.** After each turn, if the context passes `sidekick.session.restart_above_tokens`
  (default 300000) the plugin asks the Sidekick to hand off. With `restart: true` (or after one more turn
  without it, from the last saved ledger) the agent is archived and a new one is created in the same
  workspace, subscribed again, with the ledger in its kickoff.

## Consequences

- The agent id changes at a restart; the chat column follows the project's record, not the id.
- Finish notices for subagents are the plugin's, not the daemon's: they need `notifyOnFinish: false`.
- The human's answer in the chat reaches the agent through the column's permission answer, as before.
