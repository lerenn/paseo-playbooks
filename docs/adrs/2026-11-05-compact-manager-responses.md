# Compact manager responses: mutating tools return what changed, get_run has views

Status: Accepted

## Context

`get_run`, `complete_step` and the other manager tools that change a run (`start_playbook`,
`resume`, `cancel_run`, `start_after_task`, `restart_run`) returned the whole run view: every
step's definition, latest report, outputs and summary, the run inputs and every gate in full.
On long runs that is 50–300 KB per call, which overflows the manager's tool output and fills
its context, although after a `complete_step` the manager only needs what comes next. The
"[playbooks]" message that wakes the manager already carries the step's full report.

## Decision

- Mutating manager tools return what changed as structured content: `runId`, `status`,
  `failure`, `active`, `paused`, the step they acted on (`step`: id, new status, outcome,
  attempts) when there is one, `ready`, `queued`, `running`, the open (pending) gates, the
  run `outputs` once the run has ended, and the after-tasks' status. Their text is unchanged.
- `get_run` takes `view`: `compact` (the default) or `full`.
  - `compact`: the run's status, failure, branch, outputs, ready, queued and running steps;
    per step its kind, status, outcome, attempts, turn end and the first 300 characters of
    its summary; the gates without details (comments clipped to 300 characters); loops and
    after-tasks. No reports, step outputs, step definitions or run inputs.
  - `full`: the previous view, unchanged.
- `get_run` takes an optional `steps` list that limits either view to those steps (unknown
  ids are refused).
- Compact is the default because the manager calls `get_run` most often to see where the run
  is. Consumers of the whole run ask for `full`: the manager protocol, the daemon-restart and
  takeover wake messages, `restart_run` and `start_after_task` say so, and a retro step's
  brief (step agents cannot call `get_run`) is built from `view: "full"`.

## Consequences

- A `complete_step` result drops from tens of KB to a few hundred bytes; a compact `get_run`
  of a long run is about 10–15× smaller than the full one.
- Playbooks whose descriptions ask the manager for "the full get_run output" (retros) keep
  working: the manager reads `view` in the tool's description and the protocol. Spelling out
  `view: "full"` in those descriptions is clearer.
- No change to the playbook format, run state, the panel or the RPCs.
