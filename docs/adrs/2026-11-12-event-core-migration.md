# Event core: strangler migration in stages

## Status

Accepted

## Context

`2026-11-12-event-core.md` makes the event log the core. The plugin has about 81 mutators in `engine.ts`, about 79 `store.mutate` sites and 25 enqueue sites, and one JSON file per run that existing users depend on. A rewrite in one go is not acceptable (the assessment's main warning). Every stage must ship alone, be reversible alone and leave the public contract as it was: tool API, `subscribe_events` / `list_events`, `restart_run`, manager modes, playbooks, run files.

## Decision

Strangler migration. The old imperative mutators stay the source of truth until stage 6; the new path runs next to them, is compared with them (parity), and takes over per area only once it has matched in real use.

**Technique, from stage 0.** A mutator keeps its signature and, where it changes state, also `record`s a domain event with the data a reducer needs (`server/event-core.ts`). `RunStore.mutate` takes the events of the mutation, (1) in parity mode rebuilds the area from the previous state and the events with the reducers and compares it with what the mutator made (state of the area and its history entries), (2) appends the events to the run's log, then (3) writes the snapshot and tells the listeners. Events recorded on a copy that is dropped (dry runs, a failing mutation) are never taken. Parity modes: `off`, `warn` (log the difference), `throw` (tests: fail the mutation). Config: `event_core: { log: true|false, parity: warn|off }` in `config.yaml`. Every test that uses a `RunStore` runs in `throw` mode (`vitest.config.ts`), so the whole existing suite is the parity suite of every migrated area. Rollback of any stage that is only observing: `event_core.log: false` (no log, no check, state unchanged).

**Upcast of existing run files.** A run file from before the log has no `eventSeq` (read as 0) and no log. The log starts at the snapshot: the first event of an area on that run appends `<area>.genesis` with the area's state from the file, then the event. Nothing is synthesized from history (history is prose; guessing facts from it would be the kind of silent divergence parity exists to catch). A run with no events after the upgrade has no log and costs nothing.

**Stages.** Each: what changes, what is measured, rollback, exit criteria.

| Stage | Change | Measured | Rollback | Exit |
| --- | --- | --- | --- | --- |
| 0 Infrastructure | Event log store (append-only per run, torn-line tolerant, seq per stream, compaction), envelope, area registry and reducers, `record`/`takeEvents`, parity harness, `eventSeq` on the run, `event_core` config, `store.onEvents`. No area uses it. | Unit tests of log, torn line, compaction, restart; micro-benchmark (below). | Delete the files or `log: false`. | Merged with stage 1 (it has no behaviour of its own). |
| 1 Pipeline jobs and stations | The job mutators (`addJob`, `boardTrain`, `trainEnded`, `settleJob`, `withdrawJob`, `failJobs`/`failOpenJobs`, `mirrorJob`) record events; `jobs` area reducers; public `job.queued / boarded / advanced / requeued / settled / failed / withdrawn` on the bus from committed events. | Parity on every mutation in the whole test suite (`throw`) and at start on real files (`warn`); per-mutation overhead; log growth on a real pipeline. | `event_core.log: false` removes log and parity; the `job.*` bus events remain (they do not depend on the log). Revert the PR for the rest. | One release in real use with zero parity warnings in the plugin log; benchmark within budget. |
| 2 Script `wake_on` | `script: { run, poll, wake_on: [types / filters] }` next to `poll`, driven by the internal bus (`2026-11-12-event-core-internal-wakeups.md`); `poll` stays the safety net. | Script runs started by `wake_on` vs by poll in real pipelines; no more than one run per script per min gap. | Remove `wake_on` from the playbook; the poll still runs. | A real playbook uses `wake_on` with a slow poll and ends sooner than with the poll alone. |
| 3 Steps, gates, completions | `step.*`, `gate.*` events recorded by `startAttempt`, `recordReport`, `completeStep`, `requestGate`, `decideGate`...; reducers; the bus's `step.*` / `gate.*` come from them instead of `OversightProducer`'s history cursors (same payloads). | Parity; bus event payloads identical to the producer's (compare in a test over the same runs); `list_events` order. | `log: false` and the old producer path behind a flag until the stage's exit. | One release with the old producer path still compiled, no difference in events seen. |
| 4 Manager wake-ups, enqueue sites | The 25 `enqueue` sites become events with a wake-up rule; the manager wake-up reads the internal bus instead of `tickAgain` and per-site calls. | Wake-ups per hour before and after on a real run; no missed wake-up (a run waiting for its manager is woken within one tick, as today). | Flag to the old path. | Same or fewer wake-ups, none missed in a release. |
| 5 Run lifecycle and the rest | `run.*`, after-tasks, fan-out, usage, workspace, remaining mutators. | Parity per area. | Per area. | Every area has events and reducers; every mutator records. |
| 6 Retire the old paths | The reducers produce the state (mutators become command handlers that return events); `OversightProducer`'s history scan and the snapshot-as-truth go; the snapshot becomes a cache written lazily; compaction keeps a configurable tail. A major version only if run files or tool contracts change, with an ADR. | Full-log replay equals snapshot on real runs; start time; write volume. | Per-area flag back to the mutators until the stage's exit. | One release with parity `warn` still on and no warnings. |

**Stage 7 (later, on top of stage 1 and 2):** per-job admission on a station's queue, `2026-11-12-event-core-queue-admission.md`. A train is one run carrying a batch and `trainEnded` applies one fate per job, so "park a job after QA" does not fit a train; admission decides which waiting jobs may board.

**Budget (stage 1).** One mutation of the biggest known run (3.8 MB, 1172 history entries) today: 8-15 ms to rewrite. Stage 1 adds, per mutation that records events: one `structuredClone` (about 3 ms) for parity and one append (about 0.03 ms, about 200 bytes per event). The budget is: no more than 5 ms added per mutation on that file with parity `warn`, and under 0.5 ms with `parity: off`; a pipeline log under 1 MiB between compactions. The benchmark is `EVENT_CORE_BENCH=1 npx vitest run server/event-core.bench` (`EVENT_CORE_BENCH_RUN=<run.json>` for a real file); it is not a CI gate. Measured on the development machine (Linux, Node, local disk, 30 and 500 samples): synthetic 3.78 MB run: rewrite median 8.4 ms (p95 12.9), append median 0.029 ms (p95 0.047); real run file 3.82 MB: rewrite median 14.5 ms (p95 16.3), append median 0.035 ms (p95 0.070); `structuredClone` of that file 2.9 ms; one `job.boarded` line 212 bytes. No `fsync`: an append survives a process crash but not a power loss, like the snapshot's temp-and-rename today.

## Consequences

- Each stage is a PR with its own measurements and flag; none is blocked on the next.
- During stages 1-5 the code is written twice per migrated mutation, and the tests of that area run both ways. Accepted: the duplicate is the check.
- Risk: parity only checks what events describe. A mutator that changes area state without recording an event (an unmigrated mutation of `jobs`) is caught only at the next full-log verification at start, as a warning. Stage 1 audited every writer of a job's state: all are in `engine.ts` (`runtime.ts` only calls them), and each records an event.
- Not determined: real-world mutation rates, whether five minutes of compaction slack matters, and how the lazy snapshot of stage 6 behaves with the panel's polling of `list_runs` (it reads memory, not disk, so probably not at all).
