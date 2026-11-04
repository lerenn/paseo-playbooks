# Restart a finished run from a step

Status: Accepted

## Context

A run that was canceled (for example before pausing existed, or because a step had to be
stopped at once, see `2026-11-04-pause-run.md`) could not be restarted. Everything it had
done (completed steps, their outputs, the loops, the manager's context) was lost for
practical purposes, and the only option was a new run from scratch. A
failed run has the same problem once the cause has been fixed outside the run.

## Decision

- A finished run (completed, failed or canceled) can be **restarted from a step**: the step
  sheet of a finished run shows "Restart run from here" with an optional note for the step
  (RPC `runs.restart`). This is a panel action; the manager tools do not change.
- Allowed only from a main-graph step whose `needs` are all done (completed or skipped), so
  its inputs exist. Refused while after-tasks run, on an archived run, when the manager agent
  no longer exists, when the workspace has another active run, and when the restarted run
  would exceed a `concurrency` limit (the playbook's, or a block it would hold).
- The same run is reopened: same id, run file, manager, workspace and branch. Nothing is
  copied into a new run.
- The step and every step downstream of it go back to `pending`, outputs cleared, as a
  `goto` does. Every other main step that had not finished (a parallel branch cut short by
  the cancel) goes back to `pending` too. Completed steps elsewhere keep their outputs.
  Loop counts are kept, so loop limits still apply.
- The run's status is `running` again, with no failure, no outputs and no pause. All after-tasks are
  `pending` again, including ones that already ran or were canceled: they run again (auto)
  or can be started again (manual) when the run ends. The panel warns before restarting a
  run whose after-tasks already ran.
- The note becomes the step's feedback for its next attempt. The restart is logged
  (`run_restarted`), and the manager is woken with the ready steps.

## Consequences

- Cancel is no longer final: cancel now, restart from the interrupted step later. Pause
  stays the gentle option for a live run; restart is the way back from a finished one.
- A run can go from a final status back to `running`. Code that treated a final status as
  permanent (slots, after-tasks) works with this because it re-reads the run's status.
- No manager tool restarts a run: it is a human control, like pause.
