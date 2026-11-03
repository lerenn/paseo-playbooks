# Explicit outcomes and explicit run references

Status: Accepted

Supersedes the "others fail by default" part of decision 43 of `2026-11-02-design.md` (gate
choices) and the `run_id` / `run_status` / `run_failure` by-name matching in the "details
settled while implementing" bullet of `2026-11-03-after-tasks.md`. Restates
`2026-11-03-end-inside-block.md` as one rule; its behaviour is unchanged.

## Context

The format had a few implicit rules that read differently from what they did:

- A gate's non-first choices silently failed the run when they had no `on` entry, while an
  agent step's non-first outcomes were a validation error. Two rules for one concept, and a
  custom choice such as `later: {}` failed the run without anyone writing `fail`.
- After-task inputs named `run_id`, `run_status` or `run_failure` matched run values by name,
  a special case on top of the usual matching (step outputs, then playbook inputs). Nobody
  used it yet (added in 0.6.0).
- `end` was described three ways (completes the run, ends the block, completes the task).
- Validator errors for `{{ inputs.x }}` in an `inputs:` map, or `{{ playbook.inputs.x }}` in
  a prompt, did not say which form belongs where.

## Decision

- **One outcome rule** for agent steps and gates: the first outcome (a gate's first choice)
  completes by default; `failure` (agent steps) retries, then fails the run; every other
  outcome needs an explicit `on` entry, or validation fails with
  ``step "x": outcome "abort" needs an `on` entry (complete, end, fail, goto or ask)`` (for gates:
  `choice "hold" … (complete, end, fail or goto)`). The only exception is a gate without
  `choices`: its default Approve / Reject keeps `rejected` → fail. A gate that declares
  `choices`, even `approved` / `rejected`, must give every non-first choice an `on` entry.
  The engine and the panel's destinations (`shared/gates.ts`) keep their fail fallback,
  which now only applies to the default Reject, loop-limit gates and runs saved earlier.
- **Explicit run references:** after-task inputs no longer match `run_id`, `run_status` or
  `run_failure` by name. They match by name only the run's outputs and the playbook's inputs.
  Run values are written explicitly, e.g. `run_id: "{{ run.id }}"`. A sub-playbook after-task
  whose required input has no source fails validation with
  `map it, e.g. run_id: "{{ run.id }}"`.
- **`end` ends the playbook it is written in:** the run at top level, the block when nested,
  the task inside an after-task. The docs say it this way everywhere.
- Validator errors name the right form for each place: `inputs:` maps use
  `{{ playbook.inputs.x }}` / `{{ steps.<id>.outputs.y }}`; prompts use `{{ inputs.x }}` of a
  declared input.

## Consequences

- Breaking format change, shipped as 0.7.0 under `2026-11-03-format-stability-until-v1.md`.
  Playbooks that break: a gate with custom `choices` and a non-first choice without `on`; an
  after-task relying on `run_id` / `run_status` / `run_failure` by name (a required input
  now errors; an optional one is left empty). Both fail validation with what to write.
- What a playbook does can be read from its YAML: every non-default route is written down.
