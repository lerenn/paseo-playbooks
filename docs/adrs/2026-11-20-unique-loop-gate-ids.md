# A gate id names one gate for the life of a run

## Status

Accepted.

## Context

A loop-limit gate was named `loop-<step>-<target>-<count>`, where `count` is the goto counter. `restart_run` keeps
the counter (and a block's counter reset brings it back to a lower value), so a run that hit the limit again got a gate
with the id of the earlier one, already rejected. `resume_gate` looks a gate up by id and found the old gate:
"already decided (rejected via chat)" for the new pending one. The event producer keys gates by `runId/gateId`: the
decided twin made it announce the pending gate as new, and escalate it, on every scan (six `gate.escalated` in a row).

## Decision

- A later loop-limit gate whose base id is taken gets a suffix: `loop-<step>-<target>-<count>~2`, `~3`, and so on.
  The first keeps the plain id, so existing ids and references do not change.
- `findGate` prefers the pending gate among gates that share an id (runs saved before this change).
- The event producer follows only the latest gate of an id, so a saved run holding duplicates cannot announce or
  escalate the same pending gate again; `gate.escalated` stays once per pending gate.

## Consequences

- Other gate ids (`ask-`, step, `permission-`, `manager-question-`, `admit-`) already count the existing gates and were unique.
- A tool, script or event consumer that parsed the count out of a loop-limit id must tolerate the `~n` suffix.
