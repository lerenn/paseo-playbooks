# Panel: refresh runs on Paseo agent events, with run status dots

Status: Accepted (#14). Supersedes the polling rule in section 7 of `2026-11-02-design.md`
(every 3 s while a run is active, every 30 s otherwise).

## Context

The panel must follow runs started or advanced elsewhere (by the manager, or from another
client). Paseo 0.14.0 has no plugin subscriptions, so the plugin cannot push its own events
to the panel, and fast polling is costly. Run state, however, only moves together with agent
activity: a step agent is created or finishes, or the manager's turn ends.

## Decision

- The panel subscribes to Paseo's agent updates for its workspace and refreshes runs when
  one arrives, batched over 400 ms.
- A 30 s poll stays as a backstop for changes with no agent event, such as a step timeout.
  Runs also refresh when the panel regains focus.
- Each card shows one status dot per run (up to 8, the latest), left of Start, like Paseo's
  conversation dots: blue and pulsing while running, yellow and pulsing while a gate waits,
  green when done and not yet opened, grey once opened, red when failed or canceled. Pressing
  a dot opens the card on that run. No pulse under reduced motion.

## Consequences

- The panel updates within half a second of agent activity, without fast polling.
- A change with no agent event can take up to 30 s to show.
- If Paseo adds plugin subscriptions, the plugin can push run events and drop the poll.
