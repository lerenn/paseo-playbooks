# Colours that carry a meaning are fixed, not taken from the host theme

Status: Accepted

## Context

The panel took every colour from the host theme (`accent`, `statusSuccess`, `statusWarning`, `statusDanger`). Some of them
change meaning with the theme: the "working" blue (`accent`) is green in the official Paseo theme, so a running run looked like a
finished one (`statusSuccess` is green too).

## Decision

- An indicator that carries a meaning (icons, progress lines, status text, badges, dots, run tabs, state charts: running, waiting or needs you, done, failed, paused; also severity: warning, error) comes from
  `client/semantic-colors.ts`: one fixed hue per tone (running blue, waiting orange, done green, failed red, paused violet), with
  a dark and a light value. The variant follows the theme's surface (`isDarkColor(surface1)`; the plugin `Theme` has no flag).
  Each tone also has an `on` colour for text on a fill of it.
- Chrome keeps following the theme: text, backgrounds, borders, every button (primary, plain, gate choices, "Continue anyway", "Review"; a destructive one keeps the theme's danger colour), links, selection and focus
  highlights, muted text, and the chart series of Analytics (they already use their own fixed palette).
- A new use of a state or a severity colour goes through `semanticColor` / `semanticOn`, never `theme.colors.status*` or `accent`.
- No state changes its tone, and no sort order changes.
- A run that is paused or on hold (rate limiting) uses the paused violet on its tab, its dot and its stage batch card; a running run stays blue. "Needs you" is always the waiting orange.

## Consequences

- A tone looks the same in every theme; only the shade is picked for the surface. Values are checked for contrast (at least
  4.5:1 on dark surfaces, 4.2:1 on light ones, in a unit test) but not against every possible custom theme.
- The theme's status colours are no longer used by the panel.
- The "held" and "paused" tags of the Quota limitation tab are violet too; a manual quota priority is no state and takes the theme accent.
