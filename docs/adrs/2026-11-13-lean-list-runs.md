# The panel's run list is lean; the step sheet fetches the heavy text on demand

## Status

Accepted

## Context

`runs.list` (the RPC behind the workspace panel) returned every active run's full document, polled
every 30 s and refreshed on each agent event. With 18 active runs that was 12.5 MB per call, against
0.42 MB for the overview's summaries. Most of it is text the panel never displays until a step sheet
is open: attempt prompts (about 2.4 MB), received inputs, reports and last messages of every
attempt, the role instructions and step prompt templates copied into each run's playbook (1.7 MB),
and the run's whole history (1.7 MB). The agents' `list_runs` and `get_run` tools are a different
path and are not affected.

## Decision

- `runs.list` returns each run through `leanRun` (`shared/lean.ts`): the same `Run` document, so the
  client types and readers do not change, with these fields emptied:
  attempt `prompt`; for every attempt but the latest, `inputs`, `lastMessage` and the report's
  `summary` and `outputs` (its `outcome` stays); the latest attempt's inputs are cut to the 300
  characters the sheet shows; the roles' `instructions` and the steps' `prompt` of the embedded
  playbook; every history entry except `step_skipped`, the only kind the panel reads.
- A new RPC `runs.step-detail` ({ runId, stepId }) returns that step's full state, its definition
  and its role. The step sheet fetches it when it opens, per run `seq`, and fills in the missing
  text (`withDetail`). Until it arrives the sheet shows the lean data; the lean list decides which
  attempts exist, so nothing the sheet already shows disappears, and a section that depends on
  deferred text (role instructions, prompt template) appears when it arrives.
- Nothing is removed from what the panel shows: the latest attempt's report and last message are
  kept in full, since the sheet and the graph card display them without a fetch.

## Consequences

- The list payload is smaller: 12.5 MB to 3.1 MB for the same 18 runs; the run files and the
  agents' tools are unchanged.
- A client reader of a deferred field must fetch it with `runs.step-detail`; a new panel feature that
  displays history, an earlier attempt's report or a prompt has to extend `leanRun` or the detail.
- The sheet makes one extra, small RPC when opened.
