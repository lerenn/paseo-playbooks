# `requeue_job`: put a failed job back on its pipeline

## Status

Accepted

## Context

A dev batch lost its manager twice in a row (run_fc7ea6, then run_755ccc: "manager lost (archived)"). A batch that fails puts its jobs back at the stage (`job.requeued`) only while the stage's `retries` allow; the `dev` stage has `retries: 1`, so six jobs that rode both batches failed on the pipeline, and the four that rode only the second were requeued and carried by the third batch (run_efe72b). The failed batches' own copies of the jobs still read `open`, which looked like jobs left on no active train. The six jobs were `failed`, detached (handed off with `wait: false`), and nothing could bring them back: `release` waits, `settle_job` ends a job, and a new hand-off means a new job and a new run.

## Decision

1. New agent tool `requeue_job { runId, jobId, reason? }`, for every agent except step and gate agents (like `cancel_run`). `runId` is the pipeline or one of its batches.
2. It reopens a job whose status is `failed` and which is detached: same id, inputs, outputs and passed stages; `batches` and `waiting` are rebuilt (the stages it may enter), `failedRides` reset, outcome, summary and end time cleared. The next batch of a stage takes it as usual.
3. Idempotent: an `open` job changes nothing (`changed: false`). Refused, with the reason: `settled` (a decision was taken) or `withdrawn`; a job that is not detached (its hand-off step was told `failure` and decides, or the work is handed off again); a job that passed every stage (its work shipped); a pipeline that is not active; a job with no stage left to wait at.
4. Events: domain `job.reopened` (reducer, history `job_reopened`), public `job.reopened` and one `job.queued` per stage with the new `via: reopened`.
5. **No automatic claim by a restarted batch.** A batch that fails already hands its open jobs back to the pipeline (`batchEnded`) and the next batch takes them, within `retries`. A restarted run is the same batch run; the jobs are the pipeline's, not the run's. Reopening failed jobs on restart would override the stage's `retries` and re-run work that failed repeatedly. Raising `retries` is the playbook's way to allow more rides; `requeue_job` is the caller's explicit override.
6. No playbook format change.

## Consequences

- A coordinator can recover jobs a batch failure took out, without re-handing off and without waiting.
- Reopened jobs get a fresh retry budget; a caller who loops on `requeue_job` loops on failing work.
- `list_events` and `subscribe_events` gain `job.reopened`; `job.queued` gains `via: reopened`.
- Minor version (0.93.0).
