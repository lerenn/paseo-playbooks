# A run waiting at a gate releases its quota reservation

## Status

Accepted. Refines `2026-11-21-pause-admitted-runs-to-fit-pace.md`, `2026-11-23-admitted-need-from-current-history.md`, `2026-11-23-quota-exempt-runs.md` and `2026-11-23-quota-limits-in-defaults.md` (a new `quota.gate_release_after` key).

## Context

An admitted run keeps a quota reservation for all its remaining agent steps for as long as it is active, including while it sits at a gate
(Needs you, or deferred to Waiting) for hours or days. That headroom is taken from every other run although the waiting run uses nothing.
Only the `steps` cap already ignores gates.

## Decision

1. **Waiting.** A run is *waiting* when it is active, not paused by a human, has no running, ready, queued or reported step and no running
   after-task, and has at least one open gate, every open gate waiting for a human. A deferred (Waiting) gate is an open gate, so it counts the
   same. A gate a role decider still holds does not count (it is decided by an agent within minutes, the run is about to go on), nor does a
   permission gate (its step is running). A fan-out waiting for its children has a running step: it is not waiting and keeps reserving. A step held
   for quota is ready: such a run is not waiting. The instant it began waiting is derived from run state alone (the latest attempt start or end,
   gate opening, deferral or decision), so a restart gives the same answer.
2. **Grace, option, default.** The reservation is released once the run has waited `quota_limits: { quota: { gate_release_after: 10m } }`.
   Default **10 minutes** (release is the user's request; the grace keeps a gate decided within minutes from flapping through the queue).
   `0` releases at once, `off` never releases (the earlier behaviour). It sits in the `quota` block with the other pacing settings (a feature of the
   pacing, not a flat sibling of the caps), accepted in the user config and in `defaults/main.yaml`, resolved per run like the other quota keys
   (folder defaults over user config over built-in), validated strictly in defaults. Run state: `playbook.quotaLimits.quota.gateReleaseMs`
   (optional, so older runs load).
3. **What is released.** The run's whole reservation entry (est and spent). The cost history and the running attempts' usage accounting are
   separate and untouched. The run is neither in the pace plan's remaining needs nor a candidate of the admission queue while released, so
   it is neither a reservation holder nor held in the Quota limitation tab (no client change). The need is not rebuilt at each tick:
   `refreshAdmittedNeeds` drops it instead of recomputing it.
4. **Return.** There is no event: at the first check after the gate is decided (the run has a ready step, so it is no longer waiting) the need is
   recomputed from the current history, as for any admitted run. A run that had started an agent step stays admitted: it returns through the
   pace plan (priority, then oldest), and is paused like any admitted run if it no longer fits (`rateHold` kind `pace`, one notice per episode,
   `2026-11-23-hold-notice-per-episode.md`); the gate stays decided and the decision is not lost. A run released before it ever started an agent
   step returns as a new admission in the headroom queue (priority, then oldest `createdAt`). Either way it does not queue behind newer runs
   of the same priority.
5. **Unchanged.** A human pause keeps its reservation (it is a deliberate stop the user did not ask to free; it would be consistent to free it
   too, not done here). Exempt runs release their reservation the same way (they never held a queue slot but did reserve). The warden's held
   check reads `rateHold`, which a waiting run does not have. The `playbooks` cap (runs admitted) still counts a waiting run. planPace and
   paceFit order for runs that are not waiting.

## Consequences

- Headroom held by runs parked at a gate comes back to other runs after 10 minutes; the returning run may be paused at its next step boundary.
- A restart rebuilds reservations from run state: a run waiting longer than the grace is not re-reserved.
- A run waiting inside the grace, or `off`, behaves as before.
