# Closed hours: several time ranges per day group

## Status

Accepted. Refines `2026-11-23-closed-hours-shared.md` (the block's location, layering and merge rule stand).

## Context

A slot of `closed_hours` carried one `from`-`to` range. Closing weekday nights and mornings (00:00-08:00 and 20:00-24:00) meant repeating the same `days` twice.

## Decision

- A slot entry is either the flat form (`days` + `from` + `to`, unchanged) or a nested form: `days` plus a `slots` list of `{ from, to }` ranges. Mixing the two on one entry (`from`/`to` next to `slots`), an empty nested list, or an entry with neither is refused by `validate_playbooks` with a message saying so.
- Each range, flat or nested, gets the same validation as before: `HH:MM`, `from` before `to` (`24:00` allowed, no wrap past midnight), known day names and aliases; the timezone check is unchanged. The nested ranges are strict objects (`from`, `to` only).
- A nested entry is read as one closed slot per range, so the calendar arithmetic (`closedIntervals`) is unchanged: overlapping and adjacent ranges, within or across entries, are merged before any hour is counted. The quota allowance, the warden's clock pauses and daylight-saving handling all go through it.
- The Quota tab's "Closed hours" line groups the ranges of the same days (`Sat-Sun, Mon-Fri 00:00-08:00 20:00-24:00`); the sentence in each language is unchanged.
- Run state is unchanged (the stored form stays the flat list of slots). The user config merge rule is unchanged.

## Consequences

- Existing files keep working; no migration.
- Not a new flat field: the nested list lives under the slot's own `slots` key, inside the existing `closed_hours` block.
