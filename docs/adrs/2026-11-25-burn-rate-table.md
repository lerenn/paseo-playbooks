# The burn rate section is a folded table

## Status

Accepted

## Context

The Burn rate block of the Burn rate limiting tab listed every playbook as a stack of lines (a title, one line per provider and window, a Steps disclosure). With many playbooks it filled the screen.

## Decision

- The whole block (title, (i) hint, Reset all, caption, playbooks) is a collapsible group, closed by default; the header row stays visible. The open state is kept in memory only, like the other folds of the tab.
- Inside, one table: a row per playbook, sorted by name; a column per distinct provider and window found in the data (sorted) holding the burn rate, then Attempts (the most attempts behind any window), Confidence (low when every window is low, high when none is, medium for a mix) and a right-aligned Reset. A playbook with no history shows "No history" in one cell across the data columns.
- A chevron on the row opens the playbook's steps as a small table (step, learned duration, Reset). Steps carry a duration, not a burn rate, so those are the columns.
- The table scrolls sideways on a narrow screen. `reset_burn_rate` and the inline confirmation are unchanged.

## Consequences

- Rows stay on one line whatever the number of playbooks; the cost is a wider table when providers report many windows.
- The rows are derived by a pure helper (`client/burn-rows.ts`), tested apart from the rendering.
