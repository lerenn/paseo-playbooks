# List values: a `list` variable type holding JSON text

Status: Accepted

## Context

Inputs, step outputs and run state carry scalars only (`string`, `number`, `boolean`, `enum`). A script that works out a
set of items (the ones ready to be worked on now) had to pack them into one string and every reader had to guess the
format. A fan-out step (`2026-11-12-fanout-join.md`) needs a real list as its input, and a step's join needs to give one
back.

## Decision

- New variable type `list` (inputs, step outputs, playbook outputs). Its value is a JSON array of strings, numbers,
  booleans or flat objects of those (no nesting), at most 200 items and 32,000 characters.
- It is stored as the array's canonical JSON text, so run state, the run files and the agent tools' contract are
  unchanged (`VarValue` stays a scalar; an agent reports a list as a JSON string). The script contract is unchanged too:
  a JSON array in the last line's `outputs` is accepted for a `list` output and stored as text.
- Templates render it as that text (`{{ steps.x.outputs.items }}` gives `["a","b"]`), which makes it visible in gate
  questions, prompts and `get_run`. A `list` may feed a `list` or a `string` input.
- Conditions (`when`, `if`) compare it as text; `{ empty: true }` tests an unset value, not an empty array.

## Consequences

- Additive: no existing playbook or run file changes. Older plugins load run files with `list` values as strings.
- No element access in templates (`{{ x.0 }}`) and no list functions: reading elements is the fan-out step's job.
- Alternative not taken: arrays as native run-state values. It would widen `VarValue` across the engine, the tools and the
  UI for no capability the JSON text lacks.
