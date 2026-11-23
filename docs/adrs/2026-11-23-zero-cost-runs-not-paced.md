# Zero-cost runs are not paced

## Status

Accepted. Refines `2026-11-23-quota-limits-in-defaults.md`, `2026-11-21-pause-admitted-runs-to-fit-pace.md` and `2026-11-23-run-quota-priority-override.md`.

## Context

A run whose measured history was `{points: 0, steps: 1}` had an estimate of 0 (not "no estimate"), so it was paced by cost. With usage at or over the pace ceiling the free headroom is 0 or negative, and the admission test `free >= cost` failed, or a held higher-priority waiter blocked it. A run estimated to cost nothing was held for headroom although it cannot hurt the pace.

## Decision

- A candidate whose estimated cost on a window is at most `ZERO_COST_POINTS` (0.05 points, a twentieth of a window percent: below what one usage reading resolves and what the panel shows) is treated like a run with no history: admitted without a headroom check, reserving and taking nothing, and not blocked behind a held higher-priority waiter (blocking exists to keep headroom for the waiter; this run takes none).
- The pace plan never pauses an admitted run whose remaining need is at most the same epsilon.
- Unchanged: an exhausted window (usage at or above `usable_percent`) and unavailable or exhausted-marked provider data still hold even a zero-cost run, as do the step and playbook hard caps. Runs with a real cost keep the same ordering and blocking.
- The epsilon is applied to the estimate as it is (history keeps float points), not to a rounded value.

## Consequences

- A thin sample that measured 0 (usage readings are coarse, so a short step can read 0) means "free" until later samples raise the average; no minimum sample count is required. If this proves too lenient, a minimum count in `CostHistory.samples` is the place to add one.
- The Quota limitation tab shows no "held" tag for such a run, since it is not held and reserves nothing.
