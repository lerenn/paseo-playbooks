# Remind silent steps, and let nudge_step reopen a timed-out step

Status: Accepted

## Context

A step agent can sit inside one long turn (waiting on CI, a review, a background poll) and
say nothing for a long time. The manager cannot tell a step that waits from one that is stuck,
and the step's `timeout` then fails it, even when the work is done and only the report is
missing (ANY-2898).

After a timeout, the step is `reported` with a failure the plugin wrote. `nudge_step` already
reopened reported steps, but it kept that failure as the report and re-armed the timeout from
the attempt's start, which had passed: the step timed out again at once. The manager's only
way out was `complete_step` with the outputs read from the agent's conversation.

## Decision

- A new optional `silence` key, on agent steps and in `defaults/main.yaml`: a duration, or
  `off`. Default `30m`. It does not apply to gates, script steps or playbook steps.
- While an agent step runs, the plugin checks its agent's last activity (the newest timeline
  entry). After `silence` without activity, or shortly before the step's `timeout` (a tenth of
  it, at most 5 minutes), whichever comes first, it sends the agent one message in its turn:
  report now if the work is done, or say what it is waiting for. The manager is told; it has
  nothing to do. One reminder per attempt (`silenceReminded` on the attempt), none while the
  run is paused.
- `nudge_step` on a step that timed out reopens the attempt: the plugin's timeout failure is
  dropped, so the agent's next `report_step_result` replaces it. Any reopened attempt records
  `reopenedAt`, and its timeout and silence count from there, not from its start.
- Both new attempt fields have defaults, so older run files still load.

## Consequences

- Silent steps surface before they time out, without the manager polling them.
- A step that waits on purpose gets one extra message per attempt and answers it in a line.
- Nudging a step gives it a fresh `timeout`; a manager that keeps nudging keeps it alive.
- Runs already in progress when the plugin updates get the default 30-minute reminder too.
