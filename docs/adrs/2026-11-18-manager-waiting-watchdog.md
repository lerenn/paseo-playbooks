# Manager watchdog for reported steps

## Status

Accepted

## Context

A step that reported (an agent step with a result, a script step that finished) is `reported` until its manager calls
`complete_step` (or `nudge_step`). The plugin wakes the manager once, when the report arrives. If that wake-up is lost in a
long conversation, or the manager ends its turn without acting, the step sits in "waiting for manager" in the run panel and nobody
sees it. The stall logic (`silence`, timeouts, `stale-sessions.ts`) covers steps that run and sessions that lost their tools,
not a manager that is idle while a report waits.

## Decision

- Setting `manager: { nudge: { enabled: true, after: 3m, max_interval: 30m } }`, a block next to `manager.compact`: repo-wide in
  `defaults/main.yaml`, overridable per playbook field by field, validated at load (durations, `max_interval >= after`). Default on.
- Watchdog in `Runtime.watchManagers`, called from the existing 2 s event scan and throttled to one look every 30 s (one
  agent read per manager); no new timer. A reported step waits `after` from its report (the attempt's `endedAt`), then the plugin
  sends ONE prompt to the manager naming run, step, outcome and summary; the next after 2x, 4x, ... capped at `max_interval`
  (3, 6, 12, 24, 30, 30 minutes), with no round limit, while the step is still reported. Several due steps of a run go in one prompt.
- It prompts only an idle manager: not while it runs a turn, has a question or permission request open, the run is paused or
  ended, an inbox wake-up is queued, or a gate or ask of the run is held by a human (an escalated gate included) or a role. Each
  of these would only burn tokens and cannot help. A gate held by the manager itself does not block.
- State is in the run (`managerWatch`): per step `{ reportedAt, count, lastAt, stuckEmitted }`, reset when the step's `reportedAt`
  changes or it moves, so a restart neither forgets nor repeats a prompt (a long-waiting step gets one prompt at the first look,
  then follows the backoff). The count is written before the send, inside the run's write queue, and a run is never nudged twice
  at once.
- Events (dotted names, like `step.slow`): `step.waiting_manager_stuck` after the SECOND prompt without progress, once per
  stuck episode (a new report re-arms it); `manager.question_pending` when the manager has had a question or permission request
  open for `after`, once per episode (answering it re-arms it; not repeated, unlike prompts). Both are added to the Sidekick's
  default `watch` and may be subscribed unscoped like `run.failed`. The Sidekick stays optional; core needs neither.
- The prompt is a plugin send like the manager wake-up: not a human message, no effect on silence or usage accounting.

## Consequences

- A forgotten reported step reaches the manager again, with backoff, and a human-visible event after two failed prompts.
- A manager that is itself blocked (question, human gate) is never prompted; the question event surfaces it instead.
- A new run-state field (`managerWatch`, defaulted, so older run files load) and a manager read every 30 s per active run.
- It complements, and does not replace, the stall logic: that handles steps that run or sessions that lost tools; this one
  handles reported steps and a manager that did not act.
