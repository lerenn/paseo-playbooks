# Train safety: settle outputs, shipped jobs, asks and no_deploy

Status: Accepted

## Context

On a pipeline's trains, a manager's habits cost jobs. A manager passed `job_results: "{}"` to
`complete_step`, which replaced the step's correct report and failed eight jobs for a missing
output. A job that passed every station but lacked an output was handed off again and re-entered
the first station. A step that reported `asking` was answered by `nudge_step`, so no gate was
recorded and the riding runs never learned the train waited. A job was settled `no_deploy` while
its services still deploy, from an invalid `success` outcome in a step's report.

## Decision

- `complete_step` on a train step with `settle` refuses a value of the settle output that leaves
  out jobs the report named (an empty value included); the value of the report is the default.
- Before a train's last step completes it, every open job that would leave the pipeline is
  checked against the singleton's required outputs; `complete_step` is refused naming job and output.
- A job that passed every station and still lacks an output fails with a summary saying its work
  shipped; its hand-off step is not retried (attempt flag `noRetry`).
- A step that reports an outcome whose transition is an `ask` has its ask gate opened by the
  plugin at once. `nudge_step` on a step with an open ask is refused and points to `resume`.
- `report_step_result` on a train step with `settle` refuses a `job_results` outcome that is not
  an outcome of the singleton.
- `settle_job` (and the settle output) refuses the outcome `no_deploy` for a job whose `services`
  input is set and not `none`. This is a rule of the Anyshift pipeline built into the plugin; it
  applies only to jobs that have such an input.
- Manager prompt: do not pass the settle output, do not invent an outcome, answer an ask through it.

## Consequences

- No playbook format change; run state gains `noRetry` on attempts (default false).
- The `no_deploy`/`services` rule is a naming convention, not configurable; a generic form would
  need a format option and a later ADR.
