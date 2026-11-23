# Provider usage unavailable: a provider-level state, not a run problem

## Status

Accepted. Refines `2026-11-20-rate-limiting.md` and `2026-11-20-dynamic-rate-limits.md` (the "quota data unavailable" hold),
`2026-11-23-hold-notice-per-episode.md` (an unavailable-only hold sends no notice) and `2026-11-23-quota-wording-and-throttle.md`
(the Quota tab).

## Context

A manager received "Rate limit hold (quota data unavailable for claude)" between two "insufficient headroom" notices because the
run's hold kind flipped as the usage endpoint failed and recovered. That a provider's usage cannot be read is a fact about the
provider, shared by every run that uses it, yet it was presented as a per-run hold (kind, notice, `run.held` churn, a red line
repeated under every project).

## Decision

- **State per provider, derived.** The pacer (`QuotaPacer`) keeps the first failed read of the current streak, a short reason of the
  last failure (`HTTP 429`, else the first line, at most 80 characters) and the failure count; a provider is *unavailable* when its
  reading is missing or older than `quota_limit.max_age` and reads have failed. Nothing is stored on runs; a restart starts clean.
- **RPC.** `quota.limitation` gains `providers[].usage` = `{ available, since, lastReadAt, reason, failures }`. Optional: an older
  panel ignores it, a new panel against an older server shows nothing extra.
- **Events**, on transitions only (memory of what was announced; at most one extra announcement after a restart):
  `provider.usage_unavailable` (provider, since, reason, failures, lastReadAt) and `provider.usage_restored` (provider, since,
  reason, unavailableMs). They carry no run and are allowed unscoped in `subscribe_events` like the other rare events.
- **Quota tab.** One violet (not red) line per provider, above the project rows: `Usage unavailable since 15:42 (HTTP 429) · last
  read 15:31`. In the project rows the provider's last known windows are greyed with the existing `stale` flag, their bars show usage
  only, and allowed-so-far, headroom and throttle read "unknown".
- **Runs.** Unchanged in effect: a run whose steps use an unavailable provider is still held (no fail-open). The hold keeps
  `kind: quota` with no window (compatible); it is recognised as `isUnavailableHold` (`kind quota`, provider set, window null). Its
  reason is `waiting for quota data on <provider>` with no per-run detail. The manager is **never** told of it, nor of its end; the
  notice episode stays armed, so a later real quota hold of the same run still gets its one notice. A switch of a run's hold between a
  quota-type hold and the unavailable one is an update of the same hold: no new `run_held`/`run.held`, no `run.released`, `since` kept.
- **Warden.** No provider-level finding: the warden's findings are per run (identity `check:subject`, stored in the run). The two
  events cover the provider-level case.

## Consequences

- A manager is never woken for a usage outage, and a flapping endpoint no longer produces notices or run events.
- `run.held` of a run that started with a headroom hold keeps that payload while the hold is waiting for data; `get_run` and the
  panel show the current reason.
- A provider with no failed read is never listed as unavailable at start-up, even though runs wait for the first reading.
