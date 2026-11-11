# Sidekick: a button to start a new session

## Status

Accepted

## Context

A Sidekick was replaced only by the plugin, when its context passed `sidekick.session.restart_above_tokens`. A human who wanted a fresh session (stuck, wrong direction, stale context) had no way to ask for one.

## Decision

- New RPC `sidekick.restart` (`{ workspaceId }`, same output as `sidekick.open`): archives the project's Sidekick agent and launches a new one in the same hidden workspace, starting from the last hand-off the Sidekick saved with `sidekick_handoff` (blank if none). It shares the opening lock, and clears the pending restart, hand-off request and held notices of the old agent.
- The Sidekick column's header row gets a "new session" icon next to "open as agent tab". Pressing it once turns it into "Restart?"; pressing again restarts.
- The old agent is archived, not deleted, so its conversation stays readable in Paseo.

## Consequences

The human can restart at any time, even mid-turn; whatever the old agent had not saved in a hand-off is lost to the new session. No change to the agent tools' contract or to the automatic restart.
