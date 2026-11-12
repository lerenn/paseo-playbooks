# `role.completion.auto`: the plugin applies reported outcomes itself

## Status

Accepted

## Context

Only script, hand-off and fan-out steps are completed by the plugin (`settleScripts`). Every agent step is applied by the Playbook Manager: the agent calls `report_step_result`, the plugin wakes the manager, the manager calls `complete_step`. For most reports the manager adds nothing: it accepts the reported outcome and outputs as they are, and the plugin has already validated the outputs at report time.

An assessment of past runs found: in the `release_trains` playbook, 38 of 38 outcomes the manager applied were exactly the reported ones (about one manager turn saved per train), and across all runs 726 of 760 report-to-apply pairs left the outcome unchanged.

## Decision

1. A step's `role` block takes `completion: { auto: [<outcome>, …] }` (a block under the existing `role` key, as the format rules ask). The ids must be outcomes the step declares. Example: `role: { name: qa, completion: { auto: [success, merged] } }`. It is refused with a loader error on gate, script, hand-off, branch and fan-out steps (they have no `role` block), for an undeclared outcome, for a duplicate or empty list, and for an outcome whose transition is a failure (`failure`, or `fail`/retry) or an `ask` (those always need the manager or a human). No default in `defaults.yaml`: outcome ids are specific to a step, so a repository-wide list would be meaningless; the option is per step only.
2. When the agent of such a step reports a listed outcome, and its turn ends (or it reports late, or a daemon restart is reconciled), the plugin calls the same `engine.completeStep` as `complete_step` with the report (summary and outputs included, validated as today), applies the same effects (archiving, events: `step.completed` and the rest come from the same history entries), starts the agent steps that became ready through `autoStartReady`, and lets the script steps start as usual.
3. Quiet wake: the plugin queues a line in the run's inbox (what was reported, that it applied it, what it started) but does not deliver it. The line rides along with the manager's next real wake-up. If a ready agent step could not be started, the manager is woken, as nothing else would.
4. Guard: the plugin applies only if, on a copy of the run, the completion succeeds and everything that becomes ready afterwards is an agent or script step. It does not apply, and wakes the manager as today, when applying would: end the run (the manager tells the human), open a gate (a gate step, a role-decided gate, a loop-limit gate), make a hand-off or fan-out step ready, or when the run is paused, a pipeline, or a train. Safe cases: the step completes (or ends a block, or loops with `goto`) and the next ready steps are agent or script steps; branch steps are resolved by the engine from declared conditions, with no judgement, so they are safe when they lead to agent or script steps. Why the rest is guarded: a gate, an end, a hand-off or a fan-out is a moment where the manager reports to a human or decides, which the manager must see.
5. Any outcome not listed, and every failure, stays `reported` and wakes the manager as today. A report whose outputs do not validate is already refused to the agent at report time.
6. No double apply: the application runs inside one run-store mutation that checks the step is still `reported` for the same attempt. `complete_step` on a step already applied is refused with a message saying the plugin applied it. After a daemon restart, reconcile applies a report that was recorded but not applied, or leaves it reported if the guard says so; a second restart finds the step completed and does nothing.
7. `MANAGER_PROTOCOL` and the step agent's prompt say so: the manager must not call `complete_step` for auto outcomes, and the agent is told the plugin applies the outcome as soon as it reports it. `get_run` shows a step's `autoComplete`.

## Consequences

- Fewer manager turns on routine steps, with no change to run state or to the agents' tool contract beyond the new optional `Step.autoComplete` field (absent in older runs).
- The agent's report is final for listed outcomes: nobody reviews it, so a playbook lists only outcomes it trusts.
- The first slice is reversible: remove the block and the manager applies everything again.
- Phase 2, a possible future option only: a manager that starts `on_demand`, woken only for what needs judgement. Not decided here.
