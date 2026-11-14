# Start-time check of inputs that strict fan-out templates read

Status: Accepted

Builds on `2026-11-13-open-fanout-pool.md`.

## Context

Fan-out templates (`items`, `key`, `workspace_name`, `inputs`) and a pool's `refill.inputs` are strict: an unset
`{{ inputs.<name> }}` is an error, not an empty string. A step input can be wired from an optional playbook input (not
`required`, no `default`). A run started without it passed every check, then failed at the first refill pass with a terse
"is not set" and a `refill_stopped` step, after work was already running.

## Decision

- `resolveRunInputs` (every start: `start_playbook`, the form, schedules, sub-playbook and fan-out child starts) now also
  refuses a run when a strict fan-out template reads `{{ inputs.X }}` and step input `X` is wired from `{{ playbook.inputs.N }}`
  that the run does not have. The error names `N`, the step, the template location and the fix: provide it or declare a
  non-empty `default`. It reuses the existing `required`/`default` semantics; nothing new in the format. Steps with a `when` are skipped.
- Undeclared references were already load errors (the step declares no such input / the playbook input is not declared).
- A refill pass failing on an unset reference names the template, the playbook input and the fix; the `refill_stopped`
  summary carries that text.
- No `default` filter: templates have no filters, and a placeholder grammar change would touch every consumer. An empty
  default counts as unset (existing rule), so optional inputs read here need a non-empty default.

## Consequences

Playbooks that start without such an input now fail at start, not mid-run. Timeouts and conditions are unchanged (an unset
input there already falls back or is a non-match).
