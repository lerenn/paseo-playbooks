# `requeue_job` also puts back a job a batch settled with a non-success outcome

## Status

Accepted. Supersedes the "only a `failed` job" rule (decisions 2 and 3) of `2026-11-12-requeue-job.md`; the rest of that ADR stands.

## Context

A batch can settle a detached job with an outcome that is not the normal finish (a batch settled it as `ejected`). Once the cause is fixed, the operator wants the job back in the queue, not a brand-new run started by hand (which loses the job's id, inputs and the stages it already passed). `requeue_job` refused anything but `failed`.

## Decision

1. **Same tool, wider scope.** `requeue_job { runId, jobId, reason, from_outcome? }` accepts a `failed` job and a `settled` job whose outcome is not the singleton's first outcome (the normal finish, `playbook.outcomes[0]`, the same rule that `record_followup` and the pending-follow-up flag use). A new tool was rejected: the effect, the events and the refusals are the same, and a second tool would split the one place a caller looks.
2. **`reason` is required** (non-empty), for failed and settled jobs alike (it was optional).
3. **`from_outcome` guard.** The outcome the caller expects (`failed` for a failed job, otherwise the job's outcome). If the job is in another state now (it was requeued meanwhile, or a rival decision settled it differently), nothing changes and the call errors. Without the guard, an already open job is left as it is (`changed: false`).
4. **Same effect as for a failed job:** same id, inputs, outputs and `passed` stages; the job waits at the stages it has not passed, so a job that passed an earlier stage goes back at the queue of the NEXT stage. Failed rides reset; the pending follow-up flag clears (it is derived from a settled job with no follow-up; the follow-ups recorded are moved into the history entry).
5. **History is append-only.** `Job.reopens: [{ status, outcome, summary, reason, followUps, at }]` records each manual requeue and how the job had ended before (older runs load with `[]`). The earlier `job_settled` entry stays in the run history; a `job_reopened` entry is added. The domain event `job.reopened` carries `previous`; the public event `job.reopened` gains `previousStatus` and `previousOutcome`, and still comes with one `job.queued` (`via: reopened`) per stage.
6. **`queue.max_requeues` does not block a manual requeue.** It caps the automatic requeue by outcome (`Job.requeues`). A manual requeue is an operator override, so it is not refused and does not add to that counter; it is recorded in `reopens` (its length is the manual count), and the UI shows a "Requeued by hand" badge (with `×N`) on the waiting job.
7. **Refused:** a job that finished with the normal outcome or passed every stage (shipped); a job still queued or running (open: idempotent without a guard, an error with `from_outcome`); a withdrawn job; a job not detached; a pipeline that has ended; no stage left to wait at.

## Consequences

- An ejected or otherwise set-aside job can be recovered in place, at the right stage, with its history.
- A caller who loops on `requeue_job` loops on failing work; the cap is not a safety net for manual calls.
- Callers that omitted `reason` now get an error. Minor version (0.113.0).
