# One store for the sidebar badge and the Playbooks screen

Status: Accepted. Supersedes `2026-11-05-overview-refresh-on-agent-events.md`.

## Context

The badge and the screen each held their own agent list subscription, their own poll and their
own request to the daemon, for the same changes. The plugin SDK has no channel for one of them,
or for the daemon, to push to the other; both live in the same client, though.

## Decision

- `client/overview-store.ts`: one store, created when the plugin's client starts, given to the
  sidebar row and the screen. It runs while either is shown: one agent subscription across every
  workspace (batched over 1 s) and a 60 s fallback refresh.
- With no screen open it fetches the count (`overview.needs-you`). While a screen is open it
  fetches the runs (`overview.state`) and takes the badge count from their pending gates. A
  refresh asked while one is in flight runs once after it.
- Deciding a gate or marking a run seen on the screen refreshes the store at once, so the badge
  follows in the same moment.
- `client/events.ts` keeps the agent-event code for the store (`watchAgents`) and the panel
  (`useAgentEvents`).

## Consequences

- One subscription and one request per change instead of two of each, and the badge and the
  screen always agree.
- The header buttons keep their own `header.state` poll: they need which workspaces have
  playbooks, which the store does not fetch.
