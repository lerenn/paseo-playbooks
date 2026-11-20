# Deferred gates: Waiting, separate from Needs you

## Status

Accepted

## Context

"Needs you" mixed gates a human must decide now with gates they had already reviewed and chose not to decide yet
(waiting for a PR merge, a reply, another run). The count was inflated, the header and Sidekick kept nagging, and
the only alternative was to decide wrongly or leave the gate looking unreviewed.

## Decision

- A gate gets an optional persisted `deferral`: `reason` (required), `condition`, optional `remindAt`, who and when
  (`deferredBy`, `deferredAt`), and, once it is back, `returnedAt`, `returnedBy`, `returnNote`.
- Deferring changes classification only. The gate stays `pending`; its choices, decider, `waitsForHuman`, the
  engine's decision checks and every decision path (panel, `resume`, `resume_gate`) are untouched, so a deferred
  gate can still be decided and no decision rule is weakened. Nothing is inferred from chat: the condition is stated.
- `needsReview(gate)` = open, awaiting a human, not deferred: it drives the Needs you list, its count, the header
  dot, the sidebar badge, the Sidekick's need-you count and its end-of-turn sweep. `isWaiting(gate)` drives the new
  "Waiting" section of the panel. `waitsForHuman` keeps its meaning (the run is still blocked: not "working").
- Conditions: `manual` (not tracked; a note), `date`, `run_ended` (another run of the same project completes, fails
  or is canceled; its own run is refused), `gate_decided` (another gate of the same project is decided). The plugin
  tracks only these, from persisted run state on the event scan (no LLM, no chat), so they survive restarts and a
  condition met while the daemon was down returns the gate on the first scan. A referenced run or gate that
  disappears also returns it. Anything else (a PR merge, a reply, a deploy) is `manual`: the plugin cannot see it, the
  UI and the tool say so, and an optional `remindAt` (any condition) or a hand return is the way back.
- Return: by the human (panel "Bring back" through `gates.return`), by an agent (`return_gate`), or automatically
  (date, reminder, run_ended, gate_decided). Idempotent. The gate then counts in Needs you again, and `gate.returned`
  is emitted (also for hand returns, with `automatic: false`; the caller is not echoed). `gate.deferred` is emitted on defer.
- Entry points: panel "Defer…" on a Needs you row (`gates.defer`), and Sidekick/coordinator tools `defer_gate` and
  `return_gate` under the same scope as `resume_gate` (agents outside the runs only, a Sidekick only in its project,
  refused with `gates: { on_behalf: deny }`). `defer_gate` is for the human's stated wish, never to hide a gate.
- Notification: the plugin has no push or Slack facility, so "notify" means the gate reappearing in Needs you (count,
  header dot) and `gate.returned`, which the Sidekick watches by default (`DEFAULT_SIDEKICK_WATCH`; the repo's own
  Sidekick config lists it). A deferred gate emits no `gate.stale` and is skipped by the warden's `gate_open` check.
- `list_gates` and `get_run` keep listing deferred gates (`waitingForHuman` stays true) with `needsReview`,
  `deferred` and the `deferral` so scheduled agents can tell them apart.

## Consequences

- Needs you counts only what to decide now; the Waiting section keeps deferred gates visible, with why and what for,
  and marks manual tracking in a warning color.
- Honest limits: nothing observes a PR merge, a message or a deploy; manual deferrals depend on a human, the Sidekick
  or a reminder date. Tracking is polled with the event scan (about 2 s), and `date`/reminders fire at the next scan
  after the time. `run_ended` and `gate_decided` are limited to runs of the same project, and cannot be set to the gate's own run or gate.
- Persisted run files gain an optional field; older files read as never deferred.
