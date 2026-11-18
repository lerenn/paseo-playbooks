# Analytics: repeat passes and lost work instead of "wasted"

## Status

Accepted

## Context

The Analytics tab and `get_analytics` called an attempt "wasted" when it was not its step's last attempt, or
its agent did not finish (ADR 2026-11-10-token-analytics; the managers ADR and the no-cost ADR repeat the word).
But a step often runs several times by design: review/fix feedback loops (`changes_requested` goes back), and
polling loops (a `goto` with a `delay`). One such step showed over a thousand "wasted" attempts of about 1.4k
tokens each. The word hid the work that really is lost.

## Decision

- The broad number is renamed **repeat passes** (`repeatAttempts`, `repeatTokens`): the same set as before.
  It is split by why the earlier attempt ended, from data each attempt records:
  - `feedbackAttempts`: its outcome's transition is a `goto` (without `delay`) or an `ask`: the loop worked as designed;
  - `pollAttempts`: its outcome's transition is a `goto` with `delay` (`delayMs`): a re-check after a wait. This
    is the one reliable marker of a poll in attempt data (script-step polling runs inside one attempt, so it makes no repeat passes);
  - `retryAttempts`: it ended in failure or timeout (or with no loop edge) and the step ran again;
  - `interruptedAttempts`: its agent did not finish (`turnEnd` error, canceled, lost) or it reported nothing,
    including a step's last attempt (as before).
  The four add up to `repeatAttempts`.
- **Lost work** is the real loss: `lostAttempts`, `lostTokens` = retries + interrupted, and `lostShare` =
  `lostTokens` over the row's total tokens (0..1).
- **Stalled loops** are flagged separately (`stalledAttempts`, `stalledTokens`, overlapping the kinds above,
  not added to lost work): STALLED_AFTER (3) passes in a row with the same outcome and the same summary
  (polls never count: they repeat by design), or the feedback passes of a step whose loop reached its
  `max_loops` gate.
- The tab shows headline stats "Repeat passes" and "Lost work", a per-row line `<n> passes (<feedback> feedback, <polls> polls, <retries> retries, <interrupted> interrupted) · lost <tokens> (<share>%)`, and sort buttons (tokens, lost share) for the step, role and model tables.
- Manager rows have no repeat or lost work.
- Additive contract: `wastedAttempts` / `wastedTokens` stay in the schema and the tool with their old values,
  deprecated aliases of the repeat passes. The new fields default to 0 for older servers. The word "wasted"
  is gone from the UI, the tool description and the docs, apart from that note.

## Consequences

- Healthy loops stop looking like waste; high `lostShare` and stalled loops point at what to fix.
- A failure with no loop edge, or a restart, counts as a retry: a heuristic, as no attempt field records a manual restart.
- This adjusts the wording of ADR 2026-11-10-token-analytics, 2026-11-12-analytics-without-cost and
  2026-11-13-analytics-managers; their decisions otherwise stand.
