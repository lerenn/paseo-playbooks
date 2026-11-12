# Script steps: wake_on

## Status

Accepted. Refines `2026-11-12-event-core-internal-wakeups.md` (decision 5, stage 2 of the event core).

## Context

A script step that waits for something can only poll. Its `poll` has to be slow enough not to hammer the outside
world, so a script that waits for another pipeline's job to settle notices it late. Stage 1 made job events public
bus events; the internal-wakeups ADR planned that a script could be woken by them.

## Decision

- **Format**, a block under `script:` next to `poll` (`.agents/skills/extend-playbook-format`):
  `script: { run: check.sh, poll: 10m, wake_on: [{ types: [job.advanced, job.settled], filter: { playbook: other_pipeline, station: production } }] }`.
  Each rule has `types` (a list of exact types or globs, as `subscribe_events` takes them) and an optional `filter`.
  A rule matches an event whose type matches one of `types` and whose payload fields equal every `filter` value;
  the step wakes when any rule matches.
- **Validation** at load, with the bus's own check (`checkTypes` in `bus.ts`, shared with `subscribe_events`): every
  type pattern must match a known event type, and every `filter` key must be a declared payload field of the chosen
  types (`olderThanMinutes` is refused: it belongs to subscriptions). `wake_on` needs `poll`, and only a script step
  has it (written on another kind or flat on a step it is refused, naming `script:`). Types known to the loader are
  the oversight and job types of the bus.
- **Listener**: one in-process `bus.onEmit` listener of the runtime, not an agent subscription (no cap, no
  debounce, not dropped when an agent is archived). It looks at each emitted event against the running script
  attempts' rules. Nothing is emitted for a wake-up.
- **Scheduling**, per script attempt: a matching event while no check runs cancels the poll timer and runs a check
  now, if at least the gap (5 s, `Runtime` option `wakeGapMs`) has passed since the last check ended, else when it
  has. While a check runs, or the gap is being waited out, further matches change nothing but a dirty flag that
  asks for one more check after the running one (and its gap): a burst of N events causes at most one extra check.
  Never more than one check of a step runs at once. The poll timer is re-armed after each check as before, and
  the persisted `nextCheckAt` follows the wake-up, so the panel's "next check in" stays right.
- **Own events**: a step is not woken by events about itself (same `runId` and `stepId` in the payload: its own
  `step.started` and `step.completed`). Events of its run that name other steps, and `job.*` events of its own
  pipeline, are delivered: a station's admission script waking on `job.queued` of its own queue is the use
  case the internal-wakeups ADR names, and the script cannot cause those itself.
- **Lifecycle**: the listener is registered when the attempt's first check starts, which includes the check
  that reruns after a daemon restart, and dropped when the attempt stops (step ended, run canceled, reset by a
  `goto`, run deleted or archived, timeout). A wake-up that finds the step gone drops it as well.
- **Observability**: each check of the live output (`runs.script-output`) has a `trigger`: `first`, `poll`, or
  `event:<type>` (default `poll` for older data); the running check's is on the output too. The step sheet shows
  "first run", "poll" or "woken by job.settled" in each check's heading and in the running line.

## Consequences

- A script waits cheaply and reacts at once; losing a wake-up (events are in memory, a restart) costs latency up to
  the poll, never correctness.
- Implemented from the internal-wakeups ADR: decision 4 (coalescing: dirty flag and 5 s gap, per consumer),
  decision 5 (script `wake_on`), 7 (nothing kept across a restart; the current check reruns), 9 (a listener that
  throws is logged and skipped). Not here: manager wake-ups, train starts and the queue admission.
- Deviations from that ADR: the rule shape is `types: [...]` (a list) instead of `type: "..."`, so one rule can
  name several types; the own-events rule is scoped to the step (see above) so that the pipeline's own job
  events still wake an admission script. The listener sees the public bus events only, not the domain events of the
  run logs.
- The gap is a constant (not per-step configurable) until a use needs it.
- `trigger` is per check in memory; nothing about wake-ups is stored in run state.
