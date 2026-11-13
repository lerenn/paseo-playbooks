# An update must not strand live agents: skip, retry and summarise the session reload

## Status

Accepted. Refines [2026-11-09-reload-stale-sessions](2026-11-09-reload-stale-sessions.md); that ADR's rules stay unless stated here.

## Context

After `paseo plugin update`, the daemon gives the reloaded plugin a new instance id and stops
listing the tools an agent attached under the old one (`getPluginTools` filters on the instance).
The tools come back only when the agent's session is reopened (`reload()`), which re-runs the
plugin's tool hook; the plugin child holds the per-agent handlers. The daemon does this by itself on
an agent's next prompt, not for an agent mid-turn. The plugin reloads idle agents at once and the
others when their turn ends. Observed with about fifteen updates in a few hours:

- an agent mid-turn (a run's manager) has no plugin tools until its turn ends, here about ten
  minutes; this gap is the daemon dropping stale-instance tools immediately, and a reload would
  cancel the turn, so the plugin cannot close it;
- every update logged an error per idle agent whose working directory was deleted (the daemon
  refuses to reopen a session there), for ever, since those agents are never archived;
- a reload that failed for a transient reason was never tried again in that generation.

## Decision

- An agent whose working directory no longer exists is skipped without an error: nothing can reopen it.
- A reload that fails is retried with a growing wait (5 s, 20 s, 1 min, 3 min), then given up on
  with one log line; the wait also applies to the turn-end path.
- The reload at start logs one summary line per update: reloaded, skipped (working directory
  gone), deferred (mid-turn, reloaded at turn end), failed with the reasons. Per-agent lines stay
  for the turn-end path.
- A worktree of an ended run that cannot be removed (typically a directory another user, such as
  a container, created inside it) is retried after 1, 5 and 15 minutes, then kept with a
  `worktree_kept` event "cleanup failed: <reason>" and left alone; the reason names the owner of
  the path when it is not the plugin's user.

## Consequences

- The mid-turn gap remains. Closing it needs the daemon to re-attach an agent's tools to the
  current plugin instance without reopening the session, for example on a tool call or listing
  that finds only stale-instance tools.
- A kept worktree that failed to clean up needs a manual removal by someone with the owner's rights.
- Not verified here: a real update against a daemon with agents mid-turn.
