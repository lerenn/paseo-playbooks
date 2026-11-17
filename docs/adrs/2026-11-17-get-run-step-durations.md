# get_run shows start, end and duration per step

## Status

Accepted

## Context

`get_run` showed a step's status but not when it ran or for how long. Agents had to read the run log or the
Playbooks panel. The attempts already record `startedAt` / `endedAt`, and `shared/slow.ts` computes durations from them.

## Decision

Both views add, optionally and only when recorded: per step `startedAt`, `endedAt` (absent while running),
`durationMs`, `live: true` while running (the duration is then the time so far), and for retried steps the current
attempt's times plus `totalMs` (full view: `attemptTimes` per attempt). The run has `startedAt` (creation),
`endedAt` (its `run_*` event) and `durationMs`. Durations reuse `elapsedMs` from `shared/slow.ts`.

## Consequences

The change is additive: consumers that ignore the fields see no difference, and no run-state migration is needed.
Runs and steps without timestamps omit the fields.
