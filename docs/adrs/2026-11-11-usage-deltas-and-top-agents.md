# Analytics: usage is a delta per turn, and a per-agent ledger lists the top consumers

Status: Accepted

## Context

`2026-11-10-token-analytics.md` assumed `lastUsage` is the usage of the turn that just ended. It is cumulative
for the agent's session (a manager whose session total was about $500 with a 92k context had been summed to about $41,000 over
84 turns in one run; managers reused across runs were summed again per run). `get_analytics` reported
manager overhead of billions of cached tokens and tens of thousands of dollars, mostly this double count.

## Decision

- Each reading is turned into a delta against the agent's previous reading (a counter that went down, after a
  restart or compaction, starts over); only the delta is added to the attempt, gate or run (`usageDelta`).
- A ledger (`agent-usage.json`, `server/usage-ledger.ts`) keeps, per agent id, the last reading and the summed
  deltas, so the delta does not depend on the run. Every agent that ends a turn is in it, also those outside the
  runs (the Sidekick, any other agent).
- `analytics` gains `topAgents`: the agents that spent the most, by cost (id, title, kind, role, model, turns,
  input / cached / output tokens, peak context, last turn), in the tool, the RPC and an Analytics "Top agents" table.

## Consequences

- Runs recorded before this version keep their inflated usage; only new turns are right.
- An agent already running at upgrade has its whole session so far counted at its first turn after it.
- `topAgents` is lifetime per agent, filtered by its last turn date; with `playbook` or `projectId`, only
  agents that served those runs.
- `runtime.analytics` is now async.
