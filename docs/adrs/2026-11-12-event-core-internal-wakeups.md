# Event core: one internal wake-up mechanism

## Status

Accepted

## Context

Three mechanisms wake the plugin today: the `tick()` loop (managers, trains, gates, timeouts), `setTimeout` polls in script steps, and the event bus (`subscribe_events`), which only wakes agents. A script step that waits for something in the outside world can only poll; a manager that should react to a job boarding has no way to be told except by the tick. Each mechanism has its own coalescing and its own gaps.

## Decision

1. **One internal bus.** Committed events (`RunStore.onEvents`, in-process, after the snapshot is written) are the single source of wake-ups. Internal consumers register an `onEmit` listener with a type pattern and a payload filter (the same glob and equality rules as agent subscriptions, `bus.ts`). Stage 1 has the first listener: the runtime maps committed job events to the public bus events. Later stages add: script `wake_on`, manager wake-ups, train starts.
2. **Agent subscriptions stay as they are**: an agent subscribes to bus events by `subscribe_events`; delivery is `idle` or `steer`, debounced, held while busy. They share the public types with internal listeners but not the delivery rules. An internal listener sees domain events of the log (including internal ones) as well as the public ones; an agent sees only the public ones.
3. **A wake-up is a hint.** A listener is told "something changed that may matter"; it then looks at the state (re-runs the check, re-reads the queue). Losing a wake-up costs latency, never correctness, because the poll and the tick stay as a safety net. This is also the rule for the external world: events never carry the truth about a code host or tracker (see `2026-11-12-event-core.md`, rule 12).
4. **Coalescing.** Per consumer: a dirty flag and a minimum gap. An event that matches sets the flag; if the consumer is not running and the gap since its last run has passed, it runs once and clears the flag; if it is running, the flag stays set and it runs once more when done, after the gap. Many events in a burst make one run. Default gap: 5 s; a consumer may ask for more. Dedup is by consumer, not by event: the same event is delivered to every matching consumer.
5. **Script `wake_on` (stage 2).** In the script block, next to `poll`: `script: { run: wait_ci.sh, poll: 10m, wake_on: [{ type: "job.settled", filter: { playbook: release_trains, station: stg } }] }`. `type` accepts globs; `filter` matches payload fields by equality and may name **another pipeline's** events (`playbook`, `station`, `runId`...: every `job.*` payload carries them); it may also name the run's own pipeline (`job.queued` for a job that boards its own queue). A wake-up re-runs the script now instead of at the next poll tick; `poll` is the safety net and is required with `wake_on`. The script's `not_yet` (exit 75) and its poll cadence are unchanged. Format rules: a block under the key it belongs to (`.agents/skills/extend-playbook-format`), refused on a non-script step, loader tests, docs.
6. **Manager wake-ups (stage 4).** `tickAgain` and per-site wake calls become rules over the same bus: "a report arrived", "a gate was decided", "a job boarded the train" wake the manager through the same coalescing, so a manager is woken at most once per gap for a burst.
7. **Restart.** Listeners keep no state across a restart. On start every consumer runs once (as the reconcile does today), which is what makes a lost wake-up harmless. The dirty flags are in memory.
8. **Ordering.** Listeners are called in event order within a stream, after the mutation is durable. Across streams there is no order; the public bus gives readers its own seq.
9. **Failure.** A listener that throws is logged and skipped; it never fails the mutation that caused the event.

Requirements of the future admission stage (see `2026-11-12-event-core-queue-admission.md`) that this ADR makes room for: a station queue's admission script is woken by (a) `job.queued` on its own queue, (b) `job.settled` or `job.advanced` of another pipeline filtered by payload such as `station` or `playbook`, (c) a slow poll (for example 10 m) as the safety net.

## Consequences

- One place to reason about "why did this run now", one coalescing rule, one test surface.
- Stage 1 ships only the registration point and the job-event mapping; no scheduling behaviour changes yet.
- Risk: a listener that is slow delays others if run inline; listeners must hand work to a queue (the runtime's mapping chains its emits). Risk: a wake-up storm if a script's own run emits events it listens to; the minimum gap bounds it, and a script's own events are not delivered to it.
- Not determined: whether gap should be per consumer in config or only in the playbook; whether the tick can ever be removed (timeouts need a clock anyway).
