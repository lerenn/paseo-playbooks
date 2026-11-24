# Three badges on the sidebar's workspace rows; SDK 0.17 and Paseo 0.16 as the minimum

## Status

Accepted.

## Context

Paseo 0.16 lets a plugin add items to the line under a workspace's title in the sidebar
(`addWorkspaceRowBadgeItem`, rendered with `WorkspaceRowBadge`). The line never wraps and truncates,
each item has a toggle in the sidebar's Show menu, and the host mounts every item's Component once
per workspace row. Until now a run could only be seen from the Playbooks screen or panel.

## Decision

- Depend on `@getpaseo/plugin` `^0.17.4` and require Paseo `>=0.16.0` in `paseo-plugin.json`.
  The upgrade changed one thing: `server.handle` became overloaded (RPCs and subscriptions), so the
  `handle` wrapper in `index.server.ts` is typed for the RPC overload.
- Three items, kept separate (the exclusion rule lives in the pure mapping, which is simpler than one
  item rendering several badges, and each keeps its toggle in the Show menu):
  - `playbook-run` (Playbooks icon): on the workspace of an active run, or of one that ended less than
    24 h ago (the active, then the latest run when there are several). Label: the step count (`3/7`)
    while the run is live, a word (`done`, `failed`, `canceled`) once it ended.
  - `playbook-state` (an icon and a word), live runs only: running (`Play`, info), paused (`Pause`,
    violet; a run paused by hand or by pace, or held by rate limiting with nothing running), waiting
    (`Hourglass`, warning; for a free slot). A run waiting at a gate has no state badge: the attention
    badge says it.
  - `playbook-attention` (warning triangle): only when the user is needed, else nothing: `gate` (an
    open gate), `slow` (a step slower than its baseline). A blocked manager is not shown: run
    summaries do not carry the warden's finding.
  So a live row reads `[workflow] 3/7 [state icon] word`; a waiting-at-gate row reads
  `[workflow] 3/7 [warning] gate`. Rows count 1 badge (ended run), 2 (running, paused, waiting for a
  slot, gate) or 3 (running or paused plus `slow`). On a narrow sidebar the line truncates: the state
  word ellipsizes first (`shrink`), the step count stays.
- Tones follow `client/semantic-colors.ts` as far as the host's five allow:

  | State | Semantic tone | Run badge | State badge |
  | --- | --- | --- | --- |
  | running | blue | `3/7`, info | `Play` running, info |
  | waiting for a slot | orange | `3/7`, warning | `Hourglass` waiting, warning |
  | waiting at a gate | orange | `3/7`, warning | none (attention `gate`, danger) |
  | paused, held by rate limiting | violet | `3/7`, muted | `Pause` paused, the plugin's own violet badge |
  | done | green | `done`, success | none |
  | failed | red | `failed`, danger | none |
  | canceled | none | `canceled`, muted | none |

  Attention: `gate` danger, `slow` warning.
- Violet has no host tone, so the paused state badge is drawn by the plugin with the host badge's
  layout (a row, centred, gap 3, shrinking and ellipsized, text 12/16, `numberOfLines` 1) from `Icon`,
  the theme's React Native `View`/`Text` and `semanticColor`, with the same accessibility label. The
  host's icon size is not in its typings; the plugin uses 12. Every other badge uses `WorkspaceRowBadge`.
- Rows do not fetch. All Components read one shared store that rides on the overview store: the
  first mounted row asks it for the runs once (the same request the screen uses, refreshed on agent
  events with a 60 s fallback), the index by workspace id is rebuilt once per new set of runs, and the
  last row releases the request.
- Every visible string is in the catalogue (en, fr, zh-CN); the accessibility label spells the full
  state and the playbook's name.

## Consequences

- The plugin no longer loads on Paseo older than 0.16.
- The runs are now fetched whenever a sidebar is shown, not only while the screen is open; the
  request is the one the screen already makes.
- Labels are deliberately short; a narrow sidebar truncates them.
