# Fan-out steps: one child run per list item, joined by the parent

Status: Accepted

Builds on `2026-11-12-list-values.md`, `2026-11-05-script-steps.md` (the plugin runs the step itself),
`2026-11-06-handoff-steps.md` and `2026-11-10-branch-steps.md`.

## Context

A playbook could not run an undetermined number of the same sub-playbook in parallel: a `playbook` step is one block
expanded at load time, and a hand-off goes to a singleton's pipeline. The wanted shape is a loop: a script lists the
items ready now, one run of a playbook per item runs in parallel (each a full playbook with its own gates), a join
checks whether items remain, and the run goes round again or ends. The plugin stays generic: items are whatever the
script outputs.

## Decision

**Format.** A step kind block `fanout:` (the key is the kind; exactly one of the kinds), with the feature's options in it:

```yaml
- id: spawn
  needs: [list]
  inputs: { items: "{{ steps.list.outputs.items }}" }
  fanout:
    playbook: batch_item        # same folder; not this playbook (directly or through a cycle), not a singleton
    items: "{{ inputs.items }}" # exactly one reference to a declared step input of type list (or a JSON string)
    key: "{{ item.id }}"        # stable per-item key; default the item itself when scalar, required for objects
    inputs: { item_id: "{{ item.id }}" }
    workspace_name: "Batch: {{ item.id }}"
    max_active: 3               # default 1, at most 50
    cancel_children: true       # default true
  on: { some_failed: complete }
  timeout: 8h
```

Templates read the step's declared `inputs` (as every other template of the format does, so wiring, ancestor and `when`
checks and sub-playbook expansion apply unchanged) plus `item`, `item.<field>` and `index`. An unset reference is an
error for that item, never "(none)". `outputs` and `outcomes` cannot be declared: they are fixed. `retries`, `timeout`,
`when`, `on` apply.

**Run model.** The plugin starts a ready fan-out step itself (no agent; `start_step` and `nudge_step` refuse it), like a
script or hand-off step: attempt id `fanout:<run>:<step>:<n>`. It evaluates the list once, giving each item a key, and
stores the children in the step (`RunStep.fanout`: key, item, rendered inputs, status, child run id, error; earlier passes
and attempts in `fanoutPast`, last 20). The scan loop that already runs every two seconds (the event watch) drives it:
it notices ended child runs, starts pending children while fewer than `max_active` are active, and joins when every child
is terminal. Waiting costs no tokens.

**Children.** A child is a run of the named playbook started through the same path as "Start in a new workspace"
(`newWorkspace`): a new workspace branched off the parent's, a new Playbook Manager, the item's `workspace_name`, and a
`parent: { runId, stepId, key }` link on the child run. All existing rules apply: the child playbook's `concurrency` (the
child waits for a free slot), duplicate-run refusal (a child with the same inputs as an active run is `not_started` with
the message), isolation, one active run per workspace (each child has its own), gates inside children go to the human as
today, hand-offs inside children stay as they are.

**Idempotency.** The child's run id is chosen and persisted with status `starting` before anything is created, so a pass,
a re-evaluation or a restart never starts a key twice. After a daemon restart the new process follows the persisted
children. A child still `starting` whose reservation is gone (the restart cut its creation) or whose manager did not
create the run within 10 minutes becomes `not_started` with the reason; the item is reported, not dropped.

**Join and outcomes.** Outcomes: `all_completed`, `some_failed` (any child failed, was canceled or not started), `failure`
(the list is unusable, keys clash, timeout). Only `all_completed` continues by default; `some_failed` fails the run unless
`on` routes it, so a failure is never ignored by accident. Fixed outputs: `results` (list of
`{key, runId, outcome, error?, output_<name>…}`, outcome one of `completed`, `failed`, `canceled`, `not_started`),
`total`, `started`, `completed`, `failed`, `canceled`, `not_started`, `any_failed`. An empty list completes at once.

**Failure policy.** A failed or canceled child does not stop its siblings: the join waits for all, then reports per-item
outcomes. (A possible future `on_child_failure` option could cancel the rest early; not built.)

**Cancel and end.** Canceling or failing the parent, resetting the step (a `goto`, restart) or its timeout cancels the
active children (each child's manager is told), marks the waiting ones `not_started`, and records `fanout_canceled`.
`cancel_children: false` leaves the children running, unobserved. A paused parent keeps its children running; its join
waits for the resume. Archiving an ended parent does not touch its children.

**Loops.** No new mechanism: a script step after the fan-out decides (`outcomes: [done, more]`, `on: { more: { goto:
list, max_loops: 10 } }`) and the `goto` reset reruns the listing. The step's loop count and earlier passes' children are
kept for the UI.

**UI (new surface).** In the Playbooks screen a run row shows each started fan-out step as a group of lanes inside the
parent: header with the step, the pass (loop count) and counts (started, running, done, failed); one compact lane per
child (key, the child's own progress line, status, a "needs you" marker when it has an open gate, press to open its
workspace). The first six lanes show (children needing a human, then running, first) with "Show all N" (scrolling beyond
12); earlier passes are listed under "Earlier passes". A child's row also reads "item <key> of <parent>"; child gates appear
in "Needs you" like any run's. The panel's graph node and the step's details sheet show the counts and children.

## Consequences

- Additive; run files from before load (new fields have defaults).
- A child's `concurrency` is checked when it starts; children being created are not yet counted, so a burst can briefly
  exceed it.
- Each child has a Playbook Manager (an agent that idles while the child works). Its cost is the child playbook's
  `manager:` settings (model, compaction) in `defaults/main.yaml`; there is no per-fan-out manager option.
- Across passes the script must not list items already done: keys deduplicate within one pass only.
- Not built: early cancel of siblings, children sharing one workspace, nested access to child step outputs (a child's
  playbook `outputs` come back as `output_<name>` in `results`).
