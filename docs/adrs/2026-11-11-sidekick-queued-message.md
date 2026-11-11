# Sidekick: queued message (Meta+Enter)

Status: Accepted

Extends `2026-11-10-sidekick-chat-column.md`.

## Context

A message sent while the Sidekick works steers the running turn. Paseo's own chat can also queue a message
for after the turn, but the daemon has no queue mode (only `steer | interrupt`, see
`2026-11-10-event-delivery-when-idle.md`): Paseo's UI queue is client-side.

## Decision

- Meta+Enter (Cmd on Mac, Ctrl+Enter elsewhere) or a **Queue** button (shown while a turn runs) holds the
  message in the Sidekick UI store, per project, as one pending line above the composer with a cancel button.
  A further queued message is appended to it.
- The column sends it, as a normal message, once the chat is live and no turn runs. Idle Sidekick: Meta+Enter
  sends at once. Enter and Shift+Enter are unchanged.
- If sending fails, the text goes back to the draft when the draft is empty.

## Consequences

- The queue lives in memory for the session and is delivered only while the column is mounted; it is lost on
  a reload.
