# Slow steps in the agent tools

## Status

Accepted. Extends `2026-11-12-slow-step-warning.md` (which stays accepted: the rule is unchanged).

## Context

The slow-step warning was computed only in the client, so the Sidekick and other agents could not answer "which
steps are flagged as slower than usual?". The client's baseline is also limited to the runs it has loaded.

## Decision

- **Same rule**: `shared/slow.ts` (`slowSteps`) is reused as is; `server/slow.ts` only feeds it the whole run history
  the server holds (archived runs included), grouped by playbook. `SlowInfo` gains `samples` (how many runs the
  baseline averages).
- **`get_run`** (compact and full): a slow step has `slow: { elapsedMs, baselineMs, factor, ratio, samples, running }`;
  the run has `slowSteps` (step ids, empty when none). Ended slow steps are included (`running: false`).
- **`list_runs`**: rows have `slowSteps` and, when not empty, `slow` (the same per-step objects). A new input
  `slow: true` keeps only the runs with a step that is slow and still running (implies active, non-archived runs;
  no new tool).
- **Event `step.slow`** (`subscribe_events`, scoped like the other step events): payload step fields plus `elapsedMs`,
  `baselineMs`, `factor`, `ratio`, `samples`; emitted once per step run when a running step first crosses the
  threshold. It is checked in the existing event scan (every 2 s tick), at most every 30 s and only while a step
  runs; no new timer. Steps already slow when the daemon starts are not announced.

## Consequences

- Additive tool contract: no existing field changes; the UI is untouched.
- Agent figures can differ slightly from the panel's, because their baseline uses the full history.
- Each `list_runs` and `get_run` call builds the baseline index over all runs (cheap at the current scale).
