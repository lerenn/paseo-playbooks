# The Analytics breakdowns include the run managers

## Status

Accepted

## Context

A run's manager agent is the biggest overhead of a run, but only the by-playbook numbers counted it.
The by-step, by-role and by-model tables and charts left it out, so which manager model cost what was
invisible and the views did not add up.

## Decision

- The manager's usage (the run's `managerUsage`, summed per-turn deltas) is counted in every
  breakdown, as its own row, in the tables and in the per-day charts:
  - by playbook: unchanged, it was already folded into the playbook's row;
  - by step: a `<playbook>/(manager)` row per playbook (a step of the playbook, so the playbook's
    manager can be compared with its steps);
  - by role: one `(manager)` row (parentheses so it never collides with a role of that name);
  - by model: under the manager's `provider/model` from the playbook's `manager` settings, `default`
    when it sets neither.
- A manager's usage has no timestamp, so it counts on the day its run was created, in the charts, as in
  the by-playbook one. Runs from before usage was recorded as deltas stay excluded, as everywhere.
- Manager rows are never "wasted": they show no wasted attempts. Their "attempts" are the runs.
- No new RPC, no schema change: the rows come from data already read.

## Consequences

- By playbook, by step, by role and by model now agree on the manager's tokens. Gate deciders are still
  only in by-playbook (a decider has no step, role or model of its own in a run), so the other views
  can sum to slightly less than the by-playbook total.
- Existing numbers keep their meaning; the step, role and model tables gain a manager row, and may
  show different totals than before in those views by exactly the manager's usage.
- The model is the playbook's configured manager model, not one chosen by a fallback, which the run
  does not record for managers.
