# Slow-step warning

## Status

Accepted.

## Context

A step that suddenly takes far longer than it usually does is often stuck (a hung agent, a script waiting on
something that will not come). Nothing in the panel tells it from a step that is simply long.

## Decision

- **Baseline**: the mean duration of the latest `runs` completed runs of the same step (same playbook id and step
  id). Only steps with status `completed` count (failed and canceled ones do not); a step's duration runs from its
  first attempt's start to its last attempt's end. At least 3 samples are needed, otherwise there is no baseline
  and no warning. The run itself is left out.
- **Slow**: the step's elapsed time (live while it runs, final once it ended) is more than `factor` times the
  baseline. Defaults: `runs` 10, `factor` 2.
- **Format**, a block (`.agents/skills/extend-playbook-format`): `slow_warning: { runs: 10, factor: 2 }`, in a
  playbook and in `defaults/main.yaml`; the playbook's fields win, field by field. `runs` is an integer of at least 3,
  `factor` a number above 1; unknown keys are refused. The loaded playbook has `slowWarning` (so a run snapshots it;
  runs from before it read the defaults).
- **Computation**: pure functions in `shared/slow.ts`, over the run history the client already has; nothing is
  persisted and no RPC is added. The Playbooks screen uses every run of `overview.state`, the panel the runs of its
  workspace (`runs.list`). To feed the screen, `RunSummary` steps gain `startedAt` and `endedAt` (default null) and
  its playbook `slowWarning`. A running step is measured again every 30 s.
- **UI**: a yellow warning triangle with a short muted detail ("12m, 3.1x the usual 4m") on the run's row of the
  Playbooks screen (naming the first slow step) and on the slow step's node in the panel.
- **Append-only**: once a warning is shown for a step of the run being displayed it stays until the run view is
  left, even if the step later ends faster than the one that raised it.

## Consequences

- No new persisted state; the warning follows the history that is loaded, so a workspace panel with few runs of its
  own may have no baseline where the Playbooks screen has one.
- Failed attempts' time inside a completed step counts in its duration (retries make it slow, which is the point).
- A step's first completion cannot warn, nor can steps of rarely run playbooks.
