# The run priority control moves from the Quota limitation tab to the Runs view

Status: Accepted. Refines `2026-11-23-run-quota-priority-override.md` (its **UI** paragraph only: the run state, the tool, the RPC, the children rule and the event are unchanged).

## Context

The priority control sat under each reservation of the Quota limitation tab, which made that tab crowded and meant a run could only be reordered from a place that is about limits, not runs. People look at runs in the Runs view, where each row already has its own action icons.

## Decision

- **Where.** In the Runs view, on the right of an active run's row (and of a fan-out child's lane, and of a Needs you / waiting row, which share the row's action area), before the manager and workspace icons: a list icon and the run's current priority. Tapping it opens a menu (the same absolute-positioned popover as the sort menu) with a stepper (minus, numeric field, plus), "Apply", "Reset" (enabled for a manual override only), a line saying "Manual (playbook default: N)" or "Playbook default", and, only for a run that has child runs, an "Apply to children" checkbox that reflects `inheritChildPriority`.
- **When it is sent.** The stepper and the field only change a draft; "Apply" (or Enter in the field) sends it, and only when the draft is a whole number in range that differs from the current priority. "Reset" and the checkbox are single actions and send at once. An explicit apply is the least error-prone on a touch screen: a stray tap while the list scrolls reorders nothing.
- **Who sees it.** An active (not finished) run whose resolved limits have pacing on. The overview payload's run summary gains `quotaPriority` (`priority`, `defaultPriority`, `override`, `hasChildren`, `inheritChildren`), `null` when there is no control (finished run, pacing off, an older server). It is computed with the same limit resolution a run uses for admission.
- **Look.** A manual override is drawn in the theme accent (never a state colour); an inherited or default priority in the muted colour.
- **Quota limitation tab.** Back to read-only: the reservations list with its "held" / "paused" tags and the exhausted block stay; the priority line, stepper, field, Reset and checkbox are removed, and the quota payload's run refs lose the priority fields.

## Consequences

- One place to reorder runs, next to the run's other actions; the Quota tab only reports.
- The overview payload grows by a small object on each active run of a pacing project; the server reads the quota layer (cached 5 s) when it builds it.
- The `set_run_priority` tool and `runs.set_priority` RPC are unchanged.
