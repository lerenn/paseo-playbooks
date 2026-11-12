# Per-job admission on a station's queue (later stage)

## Status

Accepted. Built in `2026-11-12-queue-admission-impl.md`, which records where the built version refines the details below (the entry's `held` fields, the escalation's retry, the hold's default reason).

## Context

A monorepo pipeline has jobs whose precondition (QA passed, a dependency deployed, a ticket state) may fail while others are fine; such a job must not board the `stg` / `prd` train and must not block the others. "Park a job after QA" does not fit a train: a train is one run carrying a batch and `trainEnded` applies one fate per job. The need is per-job **admission** on the station's waiting list. The agent that will implement it confirmed these requirements.

## Decision

1. **Where.** A block on the station's queue, not a step after QA: `queue: { mode: merge, admit: { script: admit_stg.sh, poll: 10m, wake_on: [...] } }`. No QA job-list input, no optional step inputs.
2. **Script input.** From plugin state, not from events: `PLAYBOOK_JOBS` = the station's **waiting** jobs, each with its `id` and its **own inputs** (`pr_urls`, `ticket`, ...), as for a train's `PLAYBOOK_JOBS`; `PLAYBOOK_STATION` = the station name. Stage 1 keeps every job's `inputs` in state and in the log.
3. **Script result**, YAML per job: `admit: [ids]`; `hold: { id: reason }` (a short reason shown in the panel and in `get_run`); `escalate: { id: reason }` (a job that cannot become admissible by itself: its dependency failed, or it was held too long). A job the script does not name is **held** with the default reason "not admitted by <script>". Exit 75 (`not_yet`) or a failure changes nothing.
4. **State.** A waiting entry gains `held: { reason, checkedAt } | null` (built: see the impl ADR); `nextTrainJobs` skips entries that are held or not yet admitted (a station with an `admit` block admits nothing by default until the script says so; a station without one behaves as today). `fifo` takes the oldest admitted job; `merge` takes every admitted one. A held job does not block the ones after it. The hold reason appears in `get_run` (the job's waiting entry), in the station's waiting list in the panel and on the Playbooks screen.
5. **Wake-ups** (`2026-11-12-event-core-internal-wakeups.md`): `wake_on` listens to `job.queued` on the station's own queue, and to `job.settled` / `job.advanced` of **another pipeline** filtered by payload (`playbook`, `station`, `runId`); the slow `poll` (for example 10 m) is the safety net. All `job.*` payloads carry `station` and `playbook` for this.
6. **Events.** `job.held` (+ `reason`) when a job becomes held or its reason changes, `job.admitted` (+ `reason`, the script's own words or empty) when it is admitted, `job.escalated` (+ `reason`) when it is escalated; same base payload as the other `job.*` events, so managers subscribe instead of polling. Each is recorded in the log first.
7. **Escalation is a human ask.** `escalate` opens an ask gate on the pipeline run for that job, attached to the station (a gate has a `stepId`; it gets an optional `jobId`), visible in the panel and in Needs you like any human gate (`gate.opened` fires, `list_gates` lists it), question "Job <id> cannot be admitted at <station>: <reason>". Choices: `retry` (hold again and run the script at once), `withdraw` (the job leaves the pipeline: `job.withdrawn`, its hand-off step is told as for a cancel), `admit` (admit anyway: the job boards the next train; recorded with the human's name and comment). While the gate is open the job is held and not escalated again.

## Consequences

- No change to trains: a train still carries a batch with one fate per job; admission only decides who boards.
- Needs a loader block (`queue.admit`, refused outside a singleton station), a gate field, a run-state field with a default, panel changes (a new surface element: held reason in the station list), and the `wake_on` of stage 2. Each gets its own ADR when built.
- Not determined: what happens to a held job when its station is removed from the playbook (probably `failJobs` as today); whether `escalate` after N holds should be a playbook option instead of the script's call.
