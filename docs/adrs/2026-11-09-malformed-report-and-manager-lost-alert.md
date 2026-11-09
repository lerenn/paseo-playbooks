# Name a malformed report, and tell someone when a manager is lost

Status: Accepted

## Context

Two failures went unnoticed. An agent called `report_step_result` five times with `outcome`
holding the rest of the call (`changes_requested</parameter><parameter name="summary">…`);
`summary` was then undefined and the error only said so. And a run failed with "manager lost
(archived)" while its manager was archived, with nobody told for 4.5 hours: the plugin only
wrote it in the run file.

## Decision

- `report_step_result` takes `summary` as optional in its schema so the plugin sees the call.
  When `outcome` or `summary` contains `</parameter>` or `<parameter name=`, the plugin splits
  the markup and, when it yields an allowed outcome, a summary and readable `outputs`, records
  the report and a `report_repaired` history entry (the tool result says so). Otherwise it
  refuses with a specific error that lists the outcomes the step accepts. A missing summary
  has its own error.
- When a run fails with "manager lost", the plugin records a `manager_archived` history
  entry before the failure with the cause it can establish: the host's `agent.archived` hook
  gives the agent and its parent, not who archived it, so the entry says that, whether the
  parent was archived too, whether the workspace still exists, and the other managers
  archived within 2 s (a batch archive reads as one event per run, each naming the others).
- The agent that created the manager, when still alive, gets a message with the run id, the
  steps reached, the cause, the `restartableFrom` list and the `restart_run` call to make.

## Consequences

- Not done, because the plugin API offers no way: a Paseo push notification, a Slack message
  for Slack-triggered runs, and the identity of whoever called the archive. Follow-ups if the
  host adds them. A run whose manager has no live parent is still only visible in the panel
  and `list_runs`.
- A summary that legitimately quotes `</parameter>` is refused or split; the error says to
  send the arguments separately.
