# Analytics: inflated pre-delta manager usage is hidden, and the tokens label says what it counts

Status: Accepted

## Context

`2026-11-11-usage-deltas-and-top-agents.md` made usage a per-turn delta (v0.66.1). Runs stored before it
keep a `managerUsage` summed from cumulative readings (e.g. $57k for one playbook), which cannot be
recovered. Also, the "Tokens" figure is input + output only, so "1.1M" next to a large cost misled.

## Decision

- Runs carry `usageDeltas: true` when created by a plugin that records deltas; stored runs lack it (false).
- `analyze` leaves out `managerUsage` of runs without the flag (totals, overhead, per-playbook) and reports
  `runsWithInvalidManagerUsage`; the Analytics summary says so in the Runs hint.
- The stat is labelled "Tokens (excl. cache)" and its hint also shows the cached count.

## Consequences

- Manager spend before v0.66.1 is not shown, rather than shown wrong. Step and decider usage of those runs
  is kept; multi-turn step attempts of those runs may also be overstated.
- A legacy run still running keeps its manager usage hidden, even for turns recorded correctly after the upgrade
  (the per-agent ledger and "Top agents" do cover them).
