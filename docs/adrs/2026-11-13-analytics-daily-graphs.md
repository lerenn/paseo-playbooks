# The Analytics tab draws each breakdown per day

## Status

Accepted

## Context

The Analytics tab shows where the tokens went in four breakdowns (by playbook, step, role and model),
summed over the chosen range. It cannot show when: a spike, a drift or a quiet week is invisible.

## Decision

- Under each of the four tables the tab adds a "<breakdown> per day" chart, a stacked bar per local
  day of the tokens (input + output, no cache: the metric the tables rank by), one colour per group.
  The tables and numbers are unchanged.
- The biggest 5 groups by total keep their series; the rest fold into one grey "Other". Days with no
  usage are drawn as empty bars. A legend gives each group's total; tapping a day shows its exact
  values (full numbers, not abbreviated).
- The days follow the range pill: from the day `since` falls on (a partial day) through today, at
  least 2 days; "All time" starts at the first recorded usage, at most 90 days back.
- Bucketing is on the server, in `analyze`, from the data already read for the tab: no new RPC and no
  run documents. `analytics.state` takes an optional `timeZone` (IANA, sent by the client) and returns
  `daily` ({ days, series } per breakdown). Day boundaries are that zone's midnight; an unknown zone
  falls back to UTC.
- A step attempt counts on the day it ended (or started, if still running), a gate decider on the day
  it was decided (or requested). A manager's usage has no timestamp, so it counts on the day its run
  was created, in the by-playbook chart only (as in the table).
- The chart is plain React Native views, no dependency.

## Consequences

- A long-running attempt's whole usage lands on one day, as its usage is kept per attempt, not per turn.
- Colours are positional: a group can change colour between ranges.
- A client older than this change ignores `daily`; a newer client on an older server shows no chart.
