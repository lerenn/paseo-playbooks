# Remove the manual rate-limit estimate

## Status

Accepted. Supersedes the manual `rate_limit.estimate` part of decisions 2 and 5 in `2026-11-20-dynamic-rate-limits.md`.

## Context

`rate_limit: { priority, estimate }` let an author state the quota points one agent step costs, winning over measured history. A
hand-written number goes stale as a playbook changes, and it competes with the measured history the plugin already keeps. One
source of truth is simpler to reason about and cannot drift.

## Decision

- The cost of a playbook's steps comes only from measured history (`rate-history.json`). A playbook with no history is not paced by
  cost until its first measure exists; the hard cap (`usable_percent`) and the "quota data unavailable" hold still apply.
- `rate_limit` keeps `priority` only. A playbook or `defaults/main.yaml` that still sets `rate_limit.estimate` fails validation
  with: "`rate_limit.estimate` was removed: the cost of a playbook comes only from its measured history ... delete the field".
- Run files stored with an `estimate` still load; the value is ignored.

## Consequences

- A playbook's first runs may overshoot the pace, since nothing can be set to avoid that; the first measure fixes it.
- Breaking for playbooks that set `estimate`: they must drop the field (the format is not yet stable, see `2026-11-03-format-stability-until-v1.md`).
- `rateHold.estimatedCost` stays, it is always derived from history.
