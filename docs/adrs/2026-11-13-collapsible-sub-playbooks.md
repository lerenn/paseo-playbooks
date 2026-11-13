# Sub-playbooks in the run view are collapsible, collapsed by default

## Status

Accepted.

## Context

The run view draws a sub-playbook as a labelled frame around all its steps. A playbook with several sub-playbooks is a tall graph where most of the steps are not the ones that matter now.

## Decision

1. Each sub-playbook (each nesting level has its own) has a toggle: the chevron and title on its frame, or, when collapsed, its whole node. Taps are the only input; no hover.
2. A collapsed sub-playbook is one node in the layout (`collapseNodes` in `shared/collapse.ts`): it needs what its steps needed from outside, and whatever needed one of its steps needs it, so edges stay intact and the layout is the ordinary memoized `layoutGraph`. Collapsing a parent hides its children; a parent's statistics count all descendant steps.
3. The node shows the name, a status (`not started`, `running`, `needs attention`, `failed`, `completed`), progress (`3/5 steps`, done = completed or skipped) and, while running, the elapsed time since its earliest attempt (shared `now` clock).
4. Loops: a loop between steps inside one collapsed sub-playbook is hidden; one that crosses its border is drawn to the node's edge. No per-step line is left dangling.
5. **Rule.** A sub-playbook is shown collapsed unless one of these holds, in order:
   1. the user toggled it by hand in this run's view: that choice wins (kept in memory per run and sub-playbook while the panel is open, not persisted);
   2. any step inside (nested ones included) is `running`, `ready`, `waiting` (on a human), `reported`, `queued` or `failed`, now or at any earlier moment the view saw: such a group opens, and stays open;
   3. there is no run (the definition view, where nothing runs and the structure is what is read): shown open.
6. **Append-only.** Collapsing is a fold the user controls over content already shown. The view only ever expands by itself, never collapses: a group opened because it ran is not closed when it finishes. The "collapsed by default" applies to what a view shows when first rendered.

## Consequences

- Nothing in the playbook format or run state changes; the state is local to the panel.
- After-task frames (they hold their own sub-playbook) and fan-out children are unchanged; they are not collapsible.
- A finished run opened later shows every sub-playbook collapsed, with its status and progress; one tap expands it.
- A manual collapse hides a step that starts running inside; the node's status and elapsed time still show it.
