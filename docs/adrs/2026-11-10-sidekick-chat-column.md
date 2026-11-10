# Sidekick chat column in the Playbooks screen

Status: Accepted

Refines `2026-11-10-sidekick.md` (it is not superseded: the Sidekick agent, its hidden workspace and the native tab stay).

## Context

The Sidekick opened as a native agent tab, which the host does not dock beside the Playbooks screen. The
plugin SDK exports no embeddable or dockable agent view, so a plugin cannot place the native chat there.

## Decision

- The Sidekick button toggles a chat column on the right of the Playbooks screen (wide layouts). The column
  is a plain chat the plugin draws over the Sidekick agent's timeline, using only the public client API
  (`agents.ref(id).timeline.refetch/subscribe`, `refresh`, `send`, `respondToPermission`, `observeEvents`).
  Compact layouts keep opening the native tab, and the column has an "open as agent tab" link.
- Code is in `client/sidekick/`: a pure reducer (`reduce.ts`, tested), a hook (`use-chat.ts`) and the view
  (`column.tsx`). `overview.tsx` only hosts the column and the toggle.
- v1 shows streaming text (Markdown), tool-call cards, permission requests (allow/deny) and questions
  (option buttons and a free answer), Stop, and a composer. A message sent mid-turn steers the turn.
- The SDK has no stop for an agent, so Stop reloads the agent's session, which interrupts the running turn.
- The SDK cannot change an agent's model or mode, so the column shows them read-only; change them in the
  native tab.

## Consequences

- Missing against the native chat: attachments, slash commands and skills, model and mode switching,
  thinking and features controls, message history paging beyond the last 200 entries.
- The reducer follows the timeline event shapes of the daemon; a change there needs a change here.
- If the host later exposes a dockable agent view, the column can go and the button can open that.
