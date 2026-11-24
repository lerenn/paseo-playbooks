# Deferred gates release at once; ordinary gates keep the grace; a returning run goes before new starts

## Status

Accepted. Refines `2026-11-24-gate-waiting-releases-reservation.md` (its single grace becomes two rules and a precedence); that ADR's definition of waiting, what is released and the option stay.

## Context

Louis asked that a run with a deferred (Waiting) gate free its quota reservation immediately, that an ordinary open gate keep it for a
configurable grace, and that a run whose gate was decided or returned come back ahead of new starts.

## Decision

1. **Deferred: no grace.** A waiting run whose open gates are *all* deferred (Waiting) releases its reservation at the next check, whatever
   the grace. A run with one deferred and one ordinary open gate keeps the ordinary rule (a human may decide the ordinary one soon).
2. **Ordinary open gate: grace.** Any other waiting run releases after `quota_limits: { quota: { gate_release_after } }`, default **10m**
   (chosen over 15m: a gate decided in minutes does not flap, a parked one frees headroom early); `0` = at once; `off` = never, for deferred
   gates too (`off` is the opt-out of the whole feature). A gate returned to review (`returnGate`, tracked or by hand) is an ordinary open
   gate again: the grace restarts from its return and the run takes its reservation back at once.
3. **Returning run first.** When the gate is decided or returned, the reservation is rebuilt at that moment (not at the next tick), so a new
   start asking afterwards already sees it taken from the headroom: an admitted run (one that started an agent step) thus beats new
   starts, and the pace plan then orders admitted runs as before (priority, then oldest). In the admission queue (a run released before
   its first agent step), a returning run sorts **after priority and before age**: a returning run goes before runs that never started at
   the same priority, but a manual or playbook priority **higher** than its own still wins. Why: the user's words are "priority over new
   starts", not over every run; a configured priority is the operator's explicit order and stays above it.
4. **Bounds.** The precedence lasts 15 minutes from the return, then the run is an ordinary candidate (priority, then oldest), so a stream of
   returning runs cannot starve new starts for longer than that. It is kept in memory: after a restart it is forgotten (the release is not).

## Risks

- **Starvation of new starts** behind returning runs: bounded by the 15-minute precedence and by priority staying first. Not bounded
  further (several returning runs at once all go first).
- **Re-admission held**: a returning run that no longer fits is held (`pace` or `headroom` hold, one notice per episode); the gate stays
  decided, nothing re-opens. It can wait as long as any held run.
- **Flapping across the grace**: a gate decided just after the grace passes frees and re-takes the headroom; another run may have taken it
  between, and the returning run is then held. A longer grace or `off` avoids it; deferred gates have no grace by design.
- The returning run's reservation is taken even when it does not fit (an admitted run is not evicted); the pace plan then pauses whoever does
  not fit, by priority then oldest.

## Consequences

- Runs parked in Waiting stop holding headroom immediately; runs awaiting a human decision keep it for 10 minutes.
- No new config key, no client change, no run-state change.
