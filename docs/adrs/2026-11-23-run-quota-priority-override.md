# A run's quota priority can be changed by hand, and passed down to its children

Status: Accepted. Builds on `2026-11-23-quota-limits-in-defaults.md` (the priority and pacing), `2026-11-23-quota-limitation-project-rows.md` (the tab's rows); the run's own `priority` from `start_playbook` stays.

## Context

The quota pace plan, the admission queue and the hold text order runs by priority (the playbook's `quota_limit.priority`, or `start_playbook`'s `priority`), then oldest first. Both are fixed when the run starts. A human watching the Quota limitation tab who sees a run held or paused could not move it ahead, and a parent that fans out many child runs (one per item) could not raise them all.

## Decision

- **Run state.** Two optional fields on a run, both loaded with defaults by older runs: `priorityOverride` (number, `null` = none) and `inheritChildPriority` (boolean, `false`). `runPriority` is: `priorityOverride`, else the run's own `priority`, else the playbook's; a child without an override still follows its parent's `priority`/playbook, never its parent's override (that reaches children only through inheritance). The override lives as long as the run and changes only by another edit.
- **Tool and RPC.** `set_run_priority { runId, priority | null, applyToChildren? }` (agent tool, registered with the run tools like `cancel_run` and `restart_run`, so callable by any non-step agent; step agents do not get it) and the `runs.set_priority` RPC (same input, used by the tab). The priority is a whole number from -1000 to 1000 (the playbook's range); `null` clears. An unknown or archived run is refused.
- **Applied at once.** The store change re-runs the held/paused check like a capacity change (`kickLimits`): a raised run resumes, a lowered one can be paused at its next step boundary; a running step is never interrupted.
- **Children, opt-in and sticky.** `applyToChildren: true` sets `inheritChildPriority` and copies the priority onto every descendant now (breadth-first through `parent`, each run once, at most 20 levels deep, so a cycle ends) and, from then on, onto every child the run starts (fan-out refills, `replace_child`; the child also gets the flag so it passes it on). `false` clears the flag without resetting children. Omitted keeps the flag; while it is on, every edit of the parent (a clear included) is copied down again. A child's own edit is its own: it wins until the parent is edited again.
- **History and event.** A `priority_changed` history entry on each run touched, and a `run.priority_changed` event on the edited run: `from`, `to`, `inheritChildren`, `cascaded` (descendants changed), `by`.
- **UI.** In the Quota limitation tab, for a project with pacing on, every run listed as reserving or held shows its priority with a minus/plus stepper, a numeric field, "Reset" (shown only for a manual override) and, for a run with children, an "Apply to children" checkbox (default as the run's flag, unchecked at first). A manual override is marked ("manual · playbook N") in the waiting colour. Checking the box applies the run's current priority to its children, unchecking stops it. A run both reserving and held is controlled once, under "Held or paused". The quota payload's run refs gain optional `priority`, `defaultPriority`, `override`, `hasChildren`, `inheritChildren`; an older server's payload hides the control.

## Consequences

- The tab is no longer read-only. The control sends only when the project paces; the server does not require pacing (a priority also orders the admission queue).
- `start_playbook`'s `priority` is unchanged and is overridden by a manual one; clearing the override brings it back.
- A manual priority on a run with the flag on rewrites its descendants' overrides, including ones a human set on a child: that is the "until the parent is edited again" rule.
- The agent tool is as widely callable as `cancel_run`; a step agent cannot change priorities.
