# Event core stage 1: pipeline job events and the `event_core` config

## Status

Accepted

## Context

Stage 1 of `2026-11-12-event-core-migration.md` moves the pipeline's jobs and stations onto the event log. It adds a public contract: bus events agents and, later, scripts can subscribe to, and a config block.

## Decision

1. **Public bus events**, source `pipelines`, one per committed job event, emitted after the mutation is durable. Each carries `runId` (the pipeline run), `playbook` (the singleton's id), `runName`, `projectId`, `workspaceDir`, `jobId`, `label`, `station` (or null), `trainRunId` (or null) and `outcome` (or null); filters match them by equality and work across pipelines.
   - `job.queued` (+ `via: handoff | advanced`): the job waits at `station`. One event per station: at hand-off, and for each station a passed station unlocks.
   - `job.boarded`: a train (`trainRunId`) took the job at `station`.
   - `job.advanced` (+ `nextStations`): the train completed with the job on it; it passed `station`.
   - `job.requeued` (+ `rides`, `retries`): the train failed, the station's retries allow another ride.
   - `job.settled` (+ `summary`): the job left with `outcome` (the last station passed, or `settle_job`); `station` and `trainRunId` are the last ride's.
   - `job.failed`, `job.withdrawn` (+ `reason`): the train failed past its retries or was canceled, the pipeline ended, a station was removed (`failed`); the hand-off was canceled, reset or timed out (`withdrawn`).
   Additive: no existing type changes. Replay with `list_events { types: ["job.*"] }`.
2. **Domain events in the log, not public:** `job.outputs_set` (a manager set outputs), `job.released` (a train ended with a job that was already settled), `train.ended`, `job.mirrored` (on a train's stream: what happened to its copy of the job).
3. **Job inputs stay readable.** Events and snapshot keep each job's own `inputs` (the `job.queued` log event carries the whole job). The future admission script reads them from state (`PLAYBOOK_JOBS`), not from bus payloads, which stay small; the bus payload does not include `inputs`.
4. **`event_core` config** in the user `config.yaml`: `event_core: { log: true | false, parity: warn | off }`, defaults `log: true`, `parity: warn`. Read once at start (reload the plugin after editing). `log: false` writes no log files and skips parity; run state is identical either way. `parity: off` keeps the log and skips the check. Malformed values fall back to the defaults. The defaults change nothing visible for users: files appear in `runs/`, and a mismatch (a bug) is a line in the plugin log.
5. **History**: the history entries written by these mutators (`job_queued`, `train_departed`, `job_requeued`, `job_outputs`, `job_settled`, `job_failed`, `job_withdrawn`, `train_ended`) keep their text; the reducers write the same text and parity compares them.
6. `job.*` bus events are emitted even with `log: false`: the flag is the way back for the log, not for a public feature.

## Consequences

- `list_events` has seven new types; bus filters declared per type (`station`, `playbook`, ...) are validated at `subscribe_events`.
- The bus holds 500 events: a busy pipeline's job events share that window with gate and step events. The log keeps a pipeline's own jobs longer (until compaction).
- A job that passes the last station emits `job.advanced` then `job.settled`.
