# Off hours tab: one row per project, with a week planner

## Status

Accepted. Supersedes `2026-11-23-off-hours-tab.md` for the layout (its data source, the optional `closedNow` field and the read-only rule stand).

## Context

The first Off hours tab showed the distinct schedules as cards. The Quota tab is organised per project, and each project resolves its own `closed_hours` from its defaults and the user config, like `quota_limits`. A list of schedules did not say which project each one belongs to, and a weekly list of times is hard to read at a glance.

## Decision

- The tab is built like the Quota tab: one row per project, in the order the server sends them, collapsed by default (a project row opens on tap, its own state), in the same card. A project without `closed_hours` is listed with "None configured" and, opened, the empty state with a pointer to the `closed_hours` key (as a project without pacing is still listed in the Quota tab).
- Collapsed summary: `Closed now · opens Mon 08:00`, `Open · closes 20:00` (the weekday only when the change is not today in the project's timezone). The dot is violet when closed, grey otherwise. When a project's playbook sets resolve to different schedules, the first closed one is summarised and `+N more` is added; opened, each is listed with its repositories.
- Opened: closed or open now and the next change (in the project's timezone), the weekly list, the week planner, and what closed hours freeze or pause.
- Week planner: one row per day of the current week (Monday first), a 24 h bar with ticks at 0/6/12/18/24, open stretches filled with the Analytics series blue (a shade that reads on dark and light surfaces) and closed stretches left empty on the outlined track (the legend says open: blue swatch, closed: outlined empty swatch), today's row emphasised and a marker at the current time of the project's timezone (the text colour with a halo of the card colour, so it shows on the blue and on the empty track). The rows fill the available width, so they fit a narrow screen unchanged. Each bar has a text alternative (`Saturday: closed all day`, `Monday: closed 00:00-08:00 and 20:00-24:00`, `… open all day`, "(today)" appended). Drawn with plain views, no charting dependency.
- Data: still `quota.limitation` (its project list and per-project limits). Each limits set with closed hours gains an optional `closedWeek: { today, nowMin, days: [{ day, lengthMin, ranges }] }`, computed by the server (`closedWeek`) from `closedIntervals`, the arithmetic the quota and the warden use, so merged ranges and daylight saving match what is applied. An older server omits it (the planner is not drawn); an older panel ignores it.
- Daylight saving: the day's real length (23 or 25 hours) is in `lengthMin` and the bar says so, but the bar is drawn on the 24 h clock: the skipped or repeated hour is not drawn. That is a deliberate simplification.
- Not done: marking a provider's quota window reset on the planner. It would need the per-provider window start and end mapped to the week and was not cheap.

## Consequences

- The state and the marker move with the tab's 30 s poll, so they may lag by that much.
- One payload field more per limits set that has closed hours; none for the others.
- Strings in English, French and Simplified Chinese.
