# A block's loop counters restart when an outer loop re-enters it

Status: Accepted

## Context

`run.loops["source->target"]` was run-wide and never reset. In a playbook that loops over
items with one block per item, a `max_loops` inside the block was shared by every item: the
third item hit "loop limit" gates its own work had not earned.

## Decision

- When a `goto` re-enters a block from outside it (the target is inside the block, the source
  is not), the loop counters and granted loop-limit allowances of every transition whose
  source is inside the block are reset to 0. Nested blocks are covered by the same rule.
- The outer transition's own counter is not reset, so its `max_loops` still opens its gate.
- A `goto` inside the block (a self-loop, say) never resets anything.
- `run.loopTotals` (new, default `{}`) keeps the cumulative count of each edge for retros.
- `{{ loop }}` and `when: { loop }` are unchanged: they count every re-run of the step and
  are not reset.

## Consequences

- `max_loops` inside a block means "per pass of the block". Playbooks that relied on one
  budget across passes need the outer loop's `max_loops` for that.
- The graph shows the current (reset) counts; older run files load with empty totals.
