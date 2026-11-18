# `add_fanout_item`: add one item to a running fan-out step

## Status

Accepted

## Context

A fan-out step starts one child run per item of a list, at most `max_active` at a time; a work pool adds
items through refill passes. An item created after the step started (a new ticket, say) could only join
through the next refill, after a child ended. Starting a separate run for it works around this, but that run
sits outside `max_active` and outside the pool, whose planner does not know it runs and may start a
conflicting item.

## Decision

- A manager tool `add_fanout_item { runId, stepId, item }` and an *Add item* field with a button in the
  step's Fan-out section of the panel (RPC `steps.add_fanout_item`, a human) add one item to a running
  fan-out step.
- The item becomes a `pending` child built by the same code as a list or refill item (`buildChild`: `key`,
  `inputs` and `workspace_name` templates, same key length and checks), and is started by the usual tick
  under `max_active`. Nothing duplicates the start path. It is in `pool.known` / `pending` / `active`, so
  refill passes see it and an item they list again is ignored as already present.
- `item` follows `parseList`: a string, number or boolean, or a flat object of scalars (an object needs
  `fanout.key`).
- Refused: the step is not a fan-out step or not running; the item is not usable or its templates do not
  render (the step's error is returned, no `not_started` child is created); its key already exists in the
  fan-out in any state; for the tool, the caller is not the manager of the run. The panel path has no manager
  check.
- Recorded as run event `fanout_item_added` (step, key, who added it) and as bus event `fanout.item_added`
  (`runId`, `stepId`, `key`, `by`; `by` is null for a human).

## Consequences

- No playbook format change and no run-state shape change: an added item is an ordinary child.
- The item is not in the original list, so a restart of the step from the start does not re-add it: it is
  added to the pass in progress only.
- A manager gets the tool after its session restarts (a plugin reload does not add tools to running agents).
- The panel field takes the item as text; text starting with `{` is parsed as a JSON object.
