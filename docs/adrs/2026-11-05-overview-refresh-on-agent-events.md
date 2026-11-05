# Playbooks screen and sidebar badge: refresh on agent events

Status: Accepted. Supersedes the polling intervals of `2026-11-05-sidebar-screen.md`; applies
`2026-11-02-panel-refresh-on-agent-events.md` to the screen and the badge.

## Context

The screen polled every 5 s and the sidebar badge every 10 s. A gate answered in the chat
left its **Needs you** row and the badge up for that long, while the panel, which refreshes on
agent events, had already dropped it.

## Decision

- The screen and the badge refresh on agent events of every workspace (one shared hook with
  the panel, `client/events.ts`), batched over 1 s since they follow the whole host.
- Their polls slow to 15 s and only catch changes with no agent activity, such as a step
  timeout firing on the daemon.

## Consequences

- A gate answered in chat, in the panel or on the screen leaves the screen and the badge
  within about a second.
- Each open screen and the badge hold an agent list subscription; on a busy host they refetch
  at most once a second.
