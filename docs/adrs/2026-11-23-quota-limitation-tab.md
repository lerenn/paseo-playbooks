# A Quota limitation tab in the Playbooks screen

Status: Accepted. The user-level limits rule is refined by `2026-11-23-quota-limitation-per-project.md`.

## Context

The quota pacing (ADR 2026-11-20-dynamic-rate-limits and the later pace ADRs) decides from usage readings, a pace ceiling,
reservations of admitted and queued runs and exhausted marks. These figures lived only in memory and in each run's
`rateHold` text, so a user could not see why work was held, how much quota the runs had reserved, or whether pacing was on.

## Decision

- A fourth top-level tab, **Quota limitation** (Runs, Analytics, Quota limitation, Profiles), shows per provider the pacing tracks:
  its state (paced, "continue anyway", usage unavailable, no usage reported), when usage was read, and for each window the raw
  usage, the pace ceiling, reservations, headroom and what is free; then the reservations per run, the runs held or paused for
  quota, and the exhausted marks. Runs held by the step or run caps are listed apart.
- A new RPC `quota.limitation` (no input) returns the figures. `buildQuotaLimitation` computes them from the same pieces the
  admission uses (`QuotaPacer.view`, `windowRooms`, the reservations, the runs); it is read-only and changes no decision.
- The figures use the user-level limits; a project's own `quota_limits` can give different `usable_percent`.
- The tab reads again every 30 s while open and has a refresh button. Strings are in en, fr and zh-CN.

## Consequences

Held and paused runs, reservations and headroom are visible in one place. A new RPC and a read-only `QuotaPacer.view`;
no change to the playbook format, run state or the agent tools. An older plugin without the RPC cannot serve the tab.
