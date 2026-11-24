# Two badges on the sidebar's workspace rows; SDK 0.17 and Paseo 0.16 as the minimum

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
- Two items, both with the Playbooks icon (the attention one a warning triangle):
  - `playbook-run`: on the workspace of an active run, or of one that ended less than 24 h ago (the
    active, then the latest run when there are several). Label: the step count (`3/7`) while running or
    waiting, else a word (`held`, `paused`, `done`, `failed`, `canceled`).
  - `playbook-attention`: only when the user is needed, else it renders nothing: `gate` (an open
    gate), `slow` (a step slower than its baseline), `held` (rate limiting holds the run and no step
    works). A blocked manager is not shown: run summaries do not carry the warden's finding.
- Tones follow `client/semantic-colors.ts` as far as the host's five allow:

  | State | Semantic tone | Badge tone |
  | --- | --- | --- |
  | running | blue | info |
  | waiting (gate, free slot) | orange | warning |
  | held, paused | orange, violet | warning (told apart by the word) |
  | done | green | success |
  | failed | red | danger |
  | canceled | none | muted |

  Attention: `gate` danger, `slow` and `held` warning.
- Rows do not fetch. Both Components read one shared store that rides on the overview store: the
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
