# The rising quota value is called "Allowed so far", not "Pace ceiling"

Status: Accepted. Supersedes the name "Pace ceiling" chosen in `2026-11-23-quota-wording-and-throttle.md` (the rest of that ADR, including the throttle formula, stands).

## Context

"Pace ceiling" still read like a limit set by the user and sat close to "Max usable quota". The two are different: one is a setting, the
other a value that grows through the window.

## Decision

- User-facing name: **Allowed so far** = Max usable quota × the share of the window already elapsed (never above Max usable quota).
  fr "Autorisé à ce stade", zh-CN "到目前为止可用". "Over by" and the collapsed line say "over the allowance" (`claude 3% over the allowance`).
- Applies to the tab, the README, the website, the agent and RPC descriptions, comments and the prose of the earlier ADRs where they state
  the current rule. Code identifiers (`ceiling`, `paceCeiling`), config keys, events and `rateHold.kind: pace` are unchanged.

## Consequences

- Text only: no change to the format, run state or the RPC payload.
