# Analytics reports tokens only: the cost figures are removed

Status: Accepted. Supersedes the cost parts of `2026-11-10-token-analytics.md`, `2026-11-11-usage-deltas-and-top-agents.md` and `2026-11-11-analytics-cost-deltas.md`.

## Context

`get_analytics` and the Analytics tab showed a dollar cost per total, playbook, step, role, model and agent,
taken from the daemon's `totalCostUsd`. Those figures are not wanted in the output.

## Decision

- `Usage` no longer has `costUsd`, and the per-turn delta no longer tracks `totalCostUsd`. Stored data that still
  has them is read fine (unknown keys are dropped).
- `get_analytics` returns no cost; `topAgents` is ordered by tokens (cached + input + output) instead of cost.
- The Analytics tab drops the Cost stat and the per-row dollar amounts; Top agents shows tokens.
- Durations, counts, tokens, peak context and wasted attempts are unchanged.

## Consequences

- Money is no longer visible anywhere in analytics; the `get_analytics` output contract loses its cost fields.
- Costs already accumulated in stored runs are ignored, not migrated.
