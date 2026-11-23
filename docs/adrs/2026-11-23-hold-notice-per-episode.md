# One manager notice per hold episode

## Status

Accepted. Refines `2026-11-23-warden-held-check.md` (its "one manager notice per hold" rule).

## Context

The previous rule sent a new notice whenever a hold's kind, provider or window changed. A hold that flips between
reasons (insufficient headroom, then quota data unavailable, then headroom again) therefore told the manager three
times in a row; each time it answered "doing nothing", at a token cost.

## Decision

- An **episode** starts when a run is first held for quota (any `rateHold` kind) and ends only when a step or after-task of
  that run starts again (or the run is no longer active).
- The manager gets **one** notice per episode, at the start. Nothing is sent for a later change of reason, kind, provider,
  window, position or retry time, nor for a hold lifted and re-taken, until a step starts.
- The release notice is kept: sent once, only if the manager was told in this episode and a step now waits for it. It does not
  re-arm the hold notice.
- The episode is read from the run's history: a `hold_notice` entry is logged when the notice is sent, `hold_release_notice`
  for the release; the latest of these and `step_started` / `after_started` gives the state. No new run field, so older runs
  load unchanged and a plugin restart forgets nothing.
- `rateHold`, `run.held` / `run.released` events and the warden `held` check are unchanged.

## Consequences

- A run held for hours costs its manager one notice, however the hold flips.
- After a restart the episode is still known. A manager that is never told of a later hold in the same episode only learns
  of it when a step is started or the hold ends with a step waiting.
