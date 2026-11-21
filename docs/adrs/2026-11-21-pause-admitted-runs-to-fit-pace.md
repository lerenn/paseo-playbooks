# Pause admitted runs to fit the pace

## Status

Accepted. Supersedes the "never evicted, held between steps only when its quota is exhausted" rule of decision 4 in `2026-11-20-dynamic-rate-limits.md`.

## Context

In `rate_limits.mode: playbook` a run was admitted once and then ran to the end, whatever the pace did later. When usage rose or
the pace tightened, ten admitted runs kept spending a quota that only had room for four.

## Decision

1. **Dynamic capacity over running runs.** Capacity is still the quota headroom (pace ceiling minus usage), each admitted run
   taking what it still has to use (the remainder of its reservation). Admitted runs compete for it by priority (higher first), then
   oldest first. Those that fit keep progressing; the others are **paused** with a `rateHold` of kind `pace` (reason, provider,
   window, `estimatedCost`, `headroom`, `position` in the resume queue, `priority`; `run.held` carries them).
2. **Only between steps.** A running step is never interrupted; a run with a step running is left as it is and paused when it reaches
   an inter-step state (the next step start is held).
3. **Resume one by one.** Every check recomputes the plan in the same order, so paused runs resume in priority then oldest order when
   the pace relaxes (headroom grows) or a continuing run ends (its need leaves the plan), never more than the capacity allows. A paused
   run keeps its reservation, so new runs are not admitted into the room it will need.
4. **A strict order.** A run that does not fit blocks lower runs on the same provider, as for admission.
5. **Unchanged.** Runs with no measured cost have no need: not paced, never paused. Exhausted quota and unavailable data still hold
   as before and win over a pace pause. Step mode, `run.released`, "Continue anyway" (now also for `pace`) and the manager and
   Sidekick awareness are as before.
6. **Immediate re-check.** Held and paused runs are re-evaluated as soon as capacity frees: when a run ends or is archived, or a step ends. The store reports each change and the runtime schedules one debounced tick (250 ms; a burst of events makes one). The 15 s timer remains the fallback (a pace that relaxes with time, a backoff).

## Consequences

- Quota spent by outside work lowers the capacity and can pause runs that were admitted under a looser pace.
- A run whose remainder never fits (very large estimate) waits until the pace ceiling grows to cover it.
- `rateHold.kind` and the `run.held` payload gain the value `pace`.
