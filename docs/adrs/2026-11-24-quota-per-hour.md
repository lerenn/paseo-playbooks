# Quota per hour: a burn rate per playbook, used to price remaining steps

## Status

Accepted. The metric is named *Burn rate* and the JSON fields renamed (`burnRate`, `quotaPerRun`) by `2026-11-24-burn-rate-naming-and-reset.md`. Refines `2026-11-20-dynamic-rate-limits.md`, `2026-11-23-admitted-need-from-current-history.md` and `2026-11-23-quota-limits-in-defaults.md` (the estimated cost of a run), and extends `2026-11-24-usage-log.md`'s family of measurements (the learned history). Zero-cost, exempt-run and returning-run rules are unchanged.

## Context

The learned cost was points per finished agent step. A run's remaining need was its remaining agent steps × that unit cost, so a long implementation step and a short polling re-check cost the same, and a playbook mixing both was over- or under-estimated. What a user reasons in is quota per hour of agent work.

## Decision

- **History** (`rate-history.json`, additive): per playbook|provider|window, `{ points, steps, ms, timedPoints }`. `ms` is the agent time that produced `timedPoints` of the points: for each finished agent attempt, its overlap with each pair of usage readings that measured its share of the increase (the attribution of `observeUsage` is reused; the same overlap is the weight and is added as time). Agent steps only; no gate, script or waiting-between-steps time; time the agent spends waiting inside its attempt counts. Per window, because a reading pair that straddles a reset is skipped for that window. An entry without `ms` loads unchanged; `timedPoints` keeps the rate honest while old untimed points decay (200-sample cap, as before). A per-step mean attempt duration is kept under `@stepTimes` per playbook|step: the whole `startedAt`→`endedAt` of each finished agent attempt (at least 1 s, as the slow-step baselines ignore shorter ones). It is not taken from the slow-step baseline (shared/slow.ts) because that is the span of a step over its runs, including gaps between retries and needs a run list; the rate's numerator is attempt time, so the duration must be too.
- **Burn rate** = `timedPoints / ms`, used for pacing once `ms` ≥ 1 minute.
- **Remaining need** of a run for a window = Σ over its remaining agent steps of: expected remaining duration × burn rate when both are known (a running step: `max(0, mean − elapsed)`), else the unit cost (points per step). Each step is priced from one source only, so nothing is counted twice; a step priced by duration is excluded from the deduction of the not yet folded measured use of running attempts (`refreshAdmittedNeeds`); steps priced by unit cost keep the deduction. Admission (`candidateCost`) and exempt reservations use the same figure, capped at what the window can hold.
- **Analytics**: `get_analytics` returns `quotaRates` (playbook, provider, window, `burnRate`, `pointsPerStep`, `quotaPerRun` = points per attempt × agent attempts per finished run in the range, `steps`, `agentMs`, `lowConfidence`). Low confidence = fewer than 5 finished attempts or less than 10 minutes of agent time. The Analytics tab shows a "Quota cost" card with a line per playbook and window and an (i) caption giving the formula; neutral and accent colours only.

## Consequences

- A long step is priced above a short one; a playbook of mostly short polling steps no longer reserves as much as its unit cost implies.
- Limitations: a looping step (a babysit re-check up to `max_loops`) is counted once, as before; parallel attempts each count their own time, so the rate is per agent hour (concurrent steps do not double count points, which are shared by time overlap, but the interval's wall time is counted once per attempt); time an agent waits inside a step is counted as active time; steps with no duration sample or a history without time fall back to the unit cost.
- A history from before this change prices as before until timed samples accumulate (at least one minute of agent time and one learned duration).
