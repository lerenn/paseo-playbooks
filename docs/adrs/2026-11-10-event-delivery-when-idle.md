# Event notices wait for the subscriber to be idle

Status: Accepted

Refines `2026-11-09-oversight-tools-and-event-subscriptions.md` (it is not superseded).

## Context

The `agent` notifier sent each notice with `activeTurnBehavior: "steer"`, so it landed in the middle of the
subscriber's running turn. A coordinator waiting on an interactive question (AskUserQuestion) kept getting event
notices back instead of the answer. The daemon has no queue mode (only `steer | interrupt`); Paseo's UI queue is
client-side: it holds the message until the turn is idle. The plugin does the same.

## Decision

- `subscribe_events` takes `delivery: "idle" | "steer"`, default `idle`; `steer` is the old behaviour. It is stored on
  the subscription; subscriptions saved before it read as `idle`.
- `idle`: the `agent` notifier answers a new outcome, `held`, while the subscriber is busy, and the bus keeps the
  events, merges later ones in (oldest first) and offers them again at the next flush. Busy is the set the plugin
  already keeps for managers (`busyManagers`: `agent.turn_started`/`turn_ended` hooks and the plugin's own sends),
  now used for any subscriber; an agent not in it (after a restart) has its status read (`running` means held and
  marked busy). `onTurnEnded` clears the mark and flushes, so the held events go out as one message, which starts a
  normal turn (the plugin is not an agent caller). A subscriber that is idle gets its message at once.
- A queue keeps at most 50 events per subscription; older ones are dropped and the message says how many
  (`list_events` replays them).
- Restarts: held queues are persisted in `pending-events.json` next to `events.json` and reloaded, so nothing held is
  lost. The subscriber's status is re-read at the first delivery.
- An archived or missing subscriber is never sent to: its subscriptions are dropped with a log line.

## Consequences

- An agent in a long turn sees notices only when it ends; one that wants them at once asks for `steer`.
- If a `turn_ended` hook were ever missed, notices stay held until that agent's next turn ends.
- The `Notifier` contract gains `held`; other sinks are unaffected.
