# Closed hours: slots that do not count towards "allowed so far"

## Status

Accepted. Refines `2026-11-20-dynamic-rate-limits.md` and `2026-11-23-quota-limits-in-defaults.md`.

## Context

What is allowed so far is `Max usable quota × share of the window elapsed`. A provider's weekly window may reset on a weekday afternoon, so the nights and the weekend inside it accrue allowance nobody can use: the open hours that remain are paced as if they had no more than their linear share.

## Decision

- A project may declare closed hours in the quota block of its `defaults/main.yaml` (or the user config), next to `usable_percent`:

  ```yaml
  quota_limits:
    quota:
      usable_percent: 90
      closed_hours:
        timezone: Europe/Paris        # IANA zone; default: the timezone of the host running the plugin
        slots:
          - { days: [saturday, sunday], from: "00:00", to: "24:00" }
          - { days: monday, from: "00:00", to: "08:00" }
  ```

  `days` is a day name (`monday`, or `mon`), a list of them, or `weekdays` / `weekend` / `everyday`. `from` and `to` are `HH:MM` on the 24-hour clock, `to` after `from`, `24:00` the end of the day. A slot does not wrap past midnight (write two slots). Overlapping slots are counted once. The block replaces the one of a lower layer as a whole, like the other `quota` fields. It is a block under `quota`, not flat fields, as the playbook format rules ask.
- Allowed so far = `Max usable quota × (open time elapsed in the window ÷ open time in the whole window)`, never above Max usable quota. Closed time is left out of both the numerator and the denominator, so the allowance stays flat during a closed slot and the open hours share the whole quota.
- Slots are read as wall-clock times of the zone, per calendar day, so a daylight-saving change gives a 23 or 25 hour day and the slot keeps its local time.
- A window with no open hour at all would divide by zero: it falls back to the plain linear rule, and the Quota limitation tab says so.
- The time at which a need fits under the allowance (the retry time of a held run) is computed in open time too.
- Nothing else changes: runs are not paused or held because a slot is closed, exempt runs and holds behave as before, and the exhausted-window rule (usage at Max usable quota) is unchanged.
- Validation (`validate_playbooks`, load time) refuses an unknown day, a time that is not `HH:MM`, `from` not before `to`, an empty slot list and an unknown timezone, naming the field.
- The Quota limitation tab shows the project's closed hours (in the reader's language) and a line while the allowance is frozen. The snapshot gains `paces[].closedKey`, `frozen`, `closedIgnored` and `limits[].closedHours`, all optional, so an older panel and an older server still work together. Pace figures are now grouped by (usable percent, closed hours) instead of the percent alone.

## Consequences

- A project that does not set it paces exactly as before.
- The closed-hours arithmetic reads the window's start and end, so it needs the same data as the allowance (window length and reset time); a window without them keeps only the hard cap, as before.
- The allowance jumps forward faster during the open hours than the plain rule: a project may spend more per open hour, and holds are released sooner, but never past Max usable quota.
- No policy is attached to a closed slot (no pause, no hold): the plugin only changes the arithmetic.
