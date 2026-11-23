# The Quota limitation tab drops its "Held or paused" block

Status: Accepted. Refines `2026-11-23-quota-limitation-project-rows.md` and `2026-11-23-quota-limitation-tab.md` (the held runs list).

## Context

Under each provider of an opened project row, "Held or paused" repeated for each run the long hold reason and retry time, which the run's own tab already shows. It made the row long without helping a decision.

## Decision

- The block is removed (and its strings). The "Reservations" list and the "Exhausted" block stay.
- A run held or paused by rate limiting appears in the reservations list with a short tag, "held" (headroom, quota, caps) or "paused" (pace), and no reason or retry text. A held run that reserves nothing yet is listed too (no remaining figures), so its priority control (`2026-11-23-run-quota-priority-override.md`) stays reachable. The RPC payload is unchanged; the merge is done in the client.

## Consequences

- The tab no longer shows why a run is held; `get_run` (`rateHold`) and the run's panel do.
