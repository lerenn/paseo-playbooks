# The Analytics tab breaks the run managers down

## Status

Accepted

## Context

A run's manager agent is the biggest overhead of a run, but its usage only showed inside the
by-playbook numbers (and the "Managers + deciders" tile). Which manager model costs what, per
playbook, was not visible.

## Decision

- A fifth breakdown, "By manager", sits after "By role" in the Analytics tab. Same structure as the
  others: title, per-day chart, table rows (tokens, runs, context peak).
- One row per playbook and manager model: `<playbook> · <provider/model>` (`default` when the playbook
  sets neither). That answers both "what does the manager of this playbook cost" and "what does this
  model cost as a manager".
- Data: the run's `managerUsage` (summed per-turn deltas) and the playbook's `manager` settings, both
  already in the run document; no new RPC. `analytics.state` returns `byManager` and `daily.byManager`.
- A manager's usage has no timestamp, so it counts on the day its run was created, as in the
  by-playbook chart. Runs from before usage was recorded as deltas stay excluded, as everywhere.
- By-playbook totals keep their meaning: they still include the manager. Manager usage therefore
  appears in both views; the breakdowns are views of the same total, not parts to add up.

## Consequences

- Rows are keyed by the manager settings of the playbook as run, not by a model actually used after a
  fallback, which the run does not record for managers.
- A newer client on an older server shows no manager breakdown; an older client ignores it.
