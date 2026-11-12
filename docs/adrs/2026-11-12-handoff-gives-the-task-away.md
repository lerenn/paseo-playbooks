# A hand-off gives the task away: it never waits and has no output

Status: Accepted

Supersedes `2026-11-06-handoff-without-waiting.md` (the opt-in `wait: false`) and the waiting
hand-off of `2026-11-06-singleton-pipelines.md` (and `2026-11-06-handoff-steps.md` before it):
their `on` mapping of the job's outcomes, the outputs fed back to the run, the withdrawal of the
job when the run is canceled, reset or times out, and the wake-ups for the job's gates.

## Specification changes

| Change                           | Where         | Kind    | Summary                                                                 |
| -------------------------------- | ------------- | ------- | ----------------------------------------------------------------------- |
| `handoff.wait`                   | hand-off step | removed | A hand-off never waits; the key is refused with what to write instead   |
| `outputs`, `on`                  | hand-off step | removed | Refused on a hand-off, with a message explaining the model              |
| `handoffWait`                    | step (loaded) | removed | Every hand-off behaves as `wait: false` did                             |
| `detached` (job)                 | run state     | changed | Always `true` for new jobs; `false` only on jobs of older run files     |

## Context

A hand-off was modelled as a sub-step: the run waited at it ("Waiting at dev of Release trains"),
routed the job's outcome through `on`, and received the singleton's outputs for its End node. In
practice the playbooks that hand work to a pipeline have nothing left to do afterwards. The
waiting mode kept runs open for days, tied their end to another playbook's, and forced
`on` entries for outcomes the origin never acts on.

## Decision

A hand-off **gives the task to another playbook**; it is not a sub-step.

- The step completes as soon as the job is accepted on the target pipeline, with the
  singleton's first outcome (or `failure` if it cannot be handed over, retried within `retries`).
  The run then continues with its next step, or ends (the typical case).
- A hand-off has **no output**, and the run receives nothing back. `outputs` and `on` on a
  hand-off step, and `handoff: { wait: ... }`, are loader errors that explain the new model and
  what to write instead (`handoff: { name: <singleton> }`). Reading `steps.<id>.outputs.*` from a
  hand-off stays refused. Until v1.0 old forms are not supported (`2026-11-03-format-stability-until-v1.md`).
- Traceability is unchanged: the hand-off attempt keeps the job reference (`job`), and the
  summary reads `Handed off to "<playbook>" (<job id>, pipeline <run>)`. `get_run`, history, the
  step node ("Handed off to <playbook> (job_x)") and the step's details sheet show it; the
  pipeline's card shows the origin run. The step node is completed, never "Waiting".
- The job is **detached** from the start: the pipeline owns it, nothing its origin run does
  withdraws it, and the origin run is never woken by its settlement or gates.
  `settle_job`, `record_followup`, `requeue_job` and pending follow-ups work on the pipeline
  alone, as they did for `wait: false` jobs.
- Run state: jobs and attempts already recorded by an older plugin version still load. A job with
  `detached: false` (a run that was waiting when the plugin was updated) keeps being delivered,
  withdrawn and told about as before until it ends; nothing creates such a job any more.

## Consequences

- Breaking change (minor version, pre-1.0). A playbook author removes `on` and `outputs` from
  hand-off steps, drops `wait`, and no longer reads `steps.<hand-off>.outputs.*` in later steps
  or in the playbook's `outputs`. A playbook that branched on how the release ended must be split:
  the singleton's own playbook starts the follow-up (`start_playbook` with `newWorkspace` and
  `forJob`, `2026-11-12-pending-follow-ups.md`).
- The hand-off step's `timeout` now only covers handing the job over.
- The admission "withdraw" answer and a canceled pipeline end the job on the pipeline only; the
  run that handed it off is not told.
