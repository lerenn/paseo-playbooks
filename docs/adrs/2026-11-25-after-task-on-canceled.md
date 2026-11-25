# An auto after-task may also start when the run is canceled

Status: Accepted

## Context

`2026-11-03-after-tasks.md` says `auto` tasks never start on a canceled run. A retro that
should follow every ended run (ANY-3302) then needs a click on a canceled one.

## Decision

- An after-task with `trigger: auto` may declare `auto: { on_canceled: true }` (default false).
  It then starts when the run is canceled, like on completion or failure; the run keeps its
  `canceled` status. Other `auto` tasks are still marked canceled, never started.
- The option is a block under `auto` (block-first rule), refused on a manual task and on a step.
- `AfterTask.onCanceled` defaults to false, so older run files load unchanged.
- Supersedes only the "not when it is canceled" clause of `2026-11-03-after-tasks.md`; the
  manager-lost case (`failRun`) still starts no after-task.

## Consequences

- Existing playbooks behave as before. A canceled run with such a task keeps its manager awake
  until the task ends.
