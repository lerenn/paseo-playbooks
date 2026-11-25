# A restart under a burn rate limit holds the run at once

## Status

Accepted. Extends 2026-11-25-restart-not-blocked-by-unstarted-after-task.

## Context

A failed run limited by burn rate (quota, pace, headroom or cap) must be restartable whatever its
queued or held after-task does, and must not stay `failed` or look unlimited after the restart.

## Decision

`restart_run` is never refused because of a queued or held after-task: it is canceled (reason `restart`)
and its reservation dropped. Right after the restart the runtime runs the rate check of the run, so a
limited run shows as held (queued by priority) immediately instead of when its first step tries to
start; the plugin lifts the hold by itself when capacity returns. A run exempt from burn rate limiting
restarts with no hold.

## Consequences

- The restarted run reserves as usual for a run with history once its step starts.
- One extra rate check per restart.
