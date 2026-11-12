# Detached jobs a batch ended: record their follow-up, keep the manager, skip steps on an empty batch

## Status

Accepted

## Context

A dev batch (run_cfab50) ended step `dev.release` with `provenance_gap`; the advisor chose `attach`, and all 7 jobs were settled `ejected`. The jobs were detached (handed off with `wait: false`), so no run was told. The playbook's manager prompt says the manager starts a rework run (`start_playbook`, `newWorkspace`) for each ejected, detached job. But the remaining steps (`dev.wait_merge`, `dev.qa`) ran on an empty batch and finished in seconds, the run completed, and the plugin archived the manager about 4 s after its last wake-up (a next batch of the stage retires the previous batch's manager). 6 of 7 jobs were lost: no rework started, and nothing showed it.

For a detached job the batch's manager is the only party that can start what follows. The plugin stays generic: it knows no profile, station or code host, only that a detached job ended with an outcome nobody was told.

## Decision

1. **A follow-up is recorded per job.** A detached job settled with an outcome other than the singleton's first (`ejected`, `no_deploy`... the first is the normal finish) has a **hand-off pending** until a follow-up is recorded on it: `Job.followUps: [{ runId, note, by, at }]` (empty by default; older runs load unchanged). Two ways to record: `start_playbook` with `forJob: "<jobId>"` (with `newWorkspace` or `workspaceId`) records the run it starts (checked before the run starts); the new tool `record_followup { runId, jobId, followUpRunId?, note? }` (any agent except step and gate agents; `runId` is the pipeline or a batch) records a run started otherwise, or, without `followUpRunId`, "none needed" with a required `note`. More than one may be recorded. Refused for a job that is open, failed, settled with the first outcome, or not detached (a waiting hand-off is told by the plugin).
2. **The run still ends normally; its manager does not.** Holding the run open was rejected: completion is a step-graph fact that restarts, after-tasks and the panel rely on, and a manager that never answers would keep a batch (and its stage, one batch at a time) open for ever. Instead the plugin keeps the manager that can act: a next batch of the stage no longer retires it while a job of its batch is pending, and the plugin wakes it, whenever it ends a turn and a job is still pending, with the list and what to do (up to 3 reminders per batch; then the hold is released and the pending state stays visible). An archived manager is not reminded. No playbook or station name is involved; the playbook's own instructions say what a follow-up is.
3. **Queryable.** `get_run` (pipeline and batch, compact and full) lists, per detached job, `followUps` (`runId`, `note`, `at`), and on the pipeline `followUpPending: true` while an ended job has none: a caller checks it before starting a rework, to avoid duplicates. The follow-up is mirrored on the batch's copy of the job. History entries `job_followup_pending` (written when a batch ends with such a job) and `job_followup`; bus events `job.followup_pending` and `job.followup` (`followUpRunId`, `note`); domain events with the same names (reducers, replayed from the log). The run summary carries each job's `detached`, `outcome` and `followUps`, and the playbook's `outcomes`.
4. **UI, append-only:** a stage whose last batch ended with such jobs shows a "Hand-off pending: N jobs ended (ejected), no follow-up started" line under its batch. Nothing shown before is removed.
5. **Empty-batch guard.** When every job of a batch has left it (ejected, requeued or settled: none open and not requeued), the main steps not started (pending, ready or queued) are skipped, with a `step_skipped` history entry ("no job left in this batch (all ejected, requeued or settled)") and a note to the manager; the batch then completes. A step already running ends as usual. A batch started with no job is unchanged.
6. The manager protocol (batch kickoff) says it: record a follow-up for each, do not end the turn before.

## Consequences

- An ejected, detached job can no longer be lost silently: the manager stays and is asked, and the pipeline says which jobs have none.
- Every non-first outcome of a detached job needs a recorded follow-up or an explicit "none needed" (for `no_deploy`, one `record_followup` call); the plugin cannot tell which outcomes mean rework.
- The hold is best effort: a manager archived by another source (its parent, the UI) cannot be kept; the pending state and event stay. Reminders are counted in memory, so a daemon restart starts them again.
- New tool `record_followup`, new `start_playbook` argument `forJob`, new `get_run` fields and two `list_events` types; no playbook YAML change. Minor version (0.96.0).
