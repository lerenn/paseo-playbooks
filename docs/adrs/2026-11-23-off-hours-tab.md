# Off hours tab: a read-only view of the closed hours

## Status

Accepted. Refines `2026-11-23-closed-hours-shared.md` and `2026-11-23-closed-hours-several-ranges.md` (the block, its layering and its effects are unchanged).

## Context

`closed_hours` shows only as one line under a project of the Quota tab, and only when the project paces. Whether a slot is closed right now, when that changes, and the fact that the warden's clocks stop too were not visible anywhere.

## Decision

- A new main tab, "Off hours", next to Quota (same level as Runs, Analytics, Quota, Profiles; same layout on compact screens). It is read-only: the schedule stays in the config file, and the empty state points to the `closed_hours` key.
- It shows: closed or open now, and the next open time (closed) or next close time (open) in the schedule's timezone; the schedule as a weekly list (days with the same ranges grouped, overlapping and adjacent ranges merged, the timezone in the title), built on the formatting of the Quota tab's line; and what a closed slot does (the Quota allowance is frozen, the warden's clocks are paused; nothing else, runs are not stopped).
- No new RPC. The tab reads `quota.limitation`, which already carries the resolved `closedHours` of each project (also with pacing off). That reading gains an optional `closedNow: { closed, changeAt }` per limits set, computed by the server (`closedState`, on the same calendar arithmetic as the quota and the warden, so daylight saving and merged slots agree). `changeAt` is null when nothing changes within a week (closed round the clock, or no slot). An older server omits it: the tab then shows the schedule without the state. An older panel ignores it.
- Projects sharing the same schedule are one card; several distinct schedules show one card each, with their projects.
- Colours: a closed slot uses the violet "paused" tone, open is neutral; no red.

## Consequences

- The state refreshes with the tab's poll (30 s) and the panel's refresh button; it may lag a slot edge by that much.
- The tab costs one more `quota.limitation` poll while it is open (same as the Quota tab).
- Strings are in English, French and Simplified Chinese.
