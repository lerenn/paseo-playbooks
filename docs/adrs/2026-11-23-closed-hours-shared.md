# Closed hours are shared by the quota and the warden

## Status

Accepted. Supersedes the location of `closed_hours` in `2026-11-23-quota-closed-hours.md` (its formula and validation stand). Refines `2026-11-18-warden.md` and `2026-11-23-warden-held-check.md`.

## Context

The closed-hours schedule first shipped as `quota_limits.quota.closed_hours`, a quota-only setting. The same nights and weekends matter to the warden: a run waiting out a weekend is not stale, slow or stalled, and a gate open across a closed slot is not neglected. Declaring the schedule twice would let the two drift apart.

## Decision

- The schedule is declared once, as a top-level `closed_hours: { timezone, slots }` block of `defaults/main.yaml` (and of the user config), next to `quota_limits` and `warden`. It is a feature block under its own key, as the playbook-format rules ask, and it describes the project's calendar, not one feature. Its fields and validation are unchanged. It is refused in a playbook, like `quota_limits`.
- Layering is unchanged: built-in (none), then the user config, then the folder's defaults, the later block replacing the earlier one as a whole.
- Quota: unchanged (the allowance is frozen only). To keep the quota reading working, the top-level block is carried in the same resolved quota layer (`quota.closedHours`) the quota already read, and the run stores it in `playbook.quotaLimits.quota.closedHours` (the stored schema now includes it). `quota_limits.quota.closed_hours` is still accepted as a deprecated alias; the top-level block wins when both are present.
- Warden: closed hours pause the clocks. Every time-based check measures open time instead of elapsed time: `stale_definition` (the run's age), `slow` (a step is slow only if its open time still passes the factor), `gate_open`, `stalled` and `held`, and the PR checks `pr_review_stale`, `pr_draft_idle` and the `failed_run` window. The pause stacks with the exclusion of held time. A clock resumes when the slot ends, so nothing fires from time spent closed, and a slot ending mid-threshold only leaves the remaining open time to wait. The schedule used is the run's own resolved one; the PR checks use the project root's defaults, then the user config.
- Without closed hours every check is exactly as before. No new finding, and the findings' values (minutes) are now open minutes when closed hours are set.

## Consequences

- One schedule drives both features; a project that sets it gets quiet nights from the warden without further configuration.
- A held run's held time and a closed slot that overlap are both subtracted from the age (stale definition), so the check may fire slightly later than strictly needed; it never fires early.
- Detail texts of `slow` and `gate_open` show open time.
- The `pr_review_stale` text still says "min ago" in wall-clock minutes while its threshold counts open time.
