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
- One rule colours a row: the run's single semantic state (`client/semantic-colors.ts`) is applied to
  ALL our badges on the row (icon and text), not to the leading dot, which stays muted grey. An open gate on the workspace makes it waiting
  (orange) whichever run the run badge shows; a slow step changes nothing. Computed in the pure
  mapping (`rowTone`, `STATE_ROW_TONES`).

  | State | Row colour (all badges, not the dot) | Run badge | State badge | Attention badge |
  | --- | --- | --- | --- | --- |
  | pipeline idle (no open job) | green | workflow icon only, no count | `CircleCheck` ready | none |
  | running | blue | `3/7` | `Play` running | `slow`, if any |
  | waiting for a slot | orange | `3/7` | `Hourglass` waiting | `slow`, if any |
  | waiting at a gate | orange | `3/7` | none | `gate` |
  | paused, held by rate limiting | violet | `3/7` | `Pause` paused | `slow`, if any |
  | done | green | `done` | none | none |
  | failed | red | `failed` | none | none |
  | canceled | none (muted) | `canceled` | none | none |

  A pipeline (a singleton's long-lived run) is idle between jobs, so its `x/y` means nothing: with no open
  job it is `ready` (computed from the run summary's `jobs`, `isPipeline`); with a job in a batch it is
  running, with only waiting jobs it is waiting.

  The host's badge tones (muted, success, warning, danger, info) stay in the data as the fallback.
- The host has no violet tone nor our fixed blue or orange, and it draws a muted "·" between its own meta
  items but not before a plugin's badges. So the plugin draws a badge itself (`PluginBadge`) for any row with
  a colour, for violet and for the dot, with
  the host badge's layout and values (read in Paseo 0.17's web UI): a row, centred, gap 3, shrinking and
  ellipsized, icon 12, text 12/16, `numberOfLines` 1, the same accessibility label. Colours come from
  the theme (`foregroundMuted`, `statusSuccess/Warning/Danger`), the fixed blue for info (the host's
  running-dot colour is not in the plugin theme) and the fixed violet from `semanticColor`. Badges
  needing none of these (a canceled run, alone) keep using `WorkspaceRowBadge`. The dot is always
  `foregroundMuted` at 70 % opacity, whatever the row's colour.
- A row shows at most one leading dot, on the first of our badges that renders, in the order run, state,
  attention (not always the run badge: it may be hidden in the Show menu). Each badge registers in the
  shared store while it renders something (`client/badge-lead.ts`) and asks whether it is first. The
  dot is the host's separator character at its size (12/16), 6 from the badge (the host's row gap) and
  never shrinks; the label does, so the row still never wraps. The host's separator colour
  (`foregroundExtraMuted`, with hover and selected variants) is not in the plugin theme: the dot is
  `foregroundMuted` at 70 % opacity for every state and does not follow the row's hover or selected colour.
- The dot separates our badges from the host's own meta items, so it shows only when the host draws at
  least one before ours (a lone "·" at the start of the line looks out of place). `hasLeadingHostItem`
  (`client/host-meta.ts`) mirrors the host's `selectMetaRowItems` (Paseo 0.17): branch, project, host badge,
  pull request, checks, running services, labels, each under its Show-menu toggle (defaults: branch and
  project off, the rest on). The plugin reads only the workspace's labels (`useWorkspace`); it cannot read the
  Show menu, the pull request or checks, the services, nor whether the host badge or project name is drawn.
  So the dot is approximated: shown when the workspace has labels (the default shows them), hidden
  otherwise, even where the host draws a pull request, checks, a branch or project the user turned on.
  Hiding when unsure is deliberate: a missing dot looks better than a lone one.
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
