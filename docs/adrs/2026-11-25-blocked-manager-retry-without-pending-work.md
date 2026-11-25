# The blocked-manager retry covers runs with an empty inbox; the stalled finding names the unblock time

## Status

Accepted. Extends 2026-11-23-manager-auto-recovery-and-fresh-workspaces.

## Context

`managerQuotaBlocked` has no expiry: it clears on a successful recovery or when a manager turn completes
without a quota notice. The 15 s timer's retry skipped any blocked run with nothing pending (empty inbox,
no recovery prompt, no ready step). A manager that must route a step outcome, or has board or hand-off
steps left, has none of these, and `deliverManager` refuses to prompt a blocked manager: the run stalled
for hours after the quota returned. The warden's `stalled` finding only said "the manager is quota-blocked".

## Decision

- `retryBlockedManagers` retries every blocked, active, unarchived, unpaused run, pending work or not. Each
  try still re-reads the shared usage reading, keeps the per-run backoff (30 s doubling to 10 min) and
  `manager_recovery.retry: false`, and a manager of a still-limited provider is never prompted: the
  recovery only succeeds when a target of the chain (or `manager_recovery.fallback`) has headroom, and clears
  a stale `exhausted` mark when usage shows headroom. A successful recovery gives the new manager its
  takeover prompt, so the pending routing work reaches it.
- A `stalled` finding for a quota-blocked manager (the plugin's block or a quota notice) states the
  earliest unblock time (the earlier of the end of an active `exhausted` mark and the reset of a blocking
  usage window, over the manager's chain; `unknown` when neither is known) and the exhausted providers.
- The unblock time's hour is part of the finding's signature: the finding is reported once per stall
  episode and again when the unblock time moves by an hour or more (or becomes known). It reaches the
  project's Sidekick through the warden summary, subscribers through `warden.finding`, and the run's detail
  in the panel, as every warden finding does; no new channel.

## Consequences

- A blocked run with an idle inbox may get a replacement manager as soon as headroom returns, even if the
  old manager had nothing queued (one extra manager agent per quota episode).
- The unblock time is an approximation: a usage reading may be stale or absent, and a mark ends at its
  `exhausted_for`, not when the provider really recovers.
