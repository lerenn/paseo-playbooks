# Sort the playbooks on the overview screen

## Status

Accepted.

## Context

The Playbooks overview screen lists one section per playbook, ordered by the most recent update among its runs.
Every run update moved sections around, so the list kept jumping. Only the rows inside a section had a sort (per
section, in memory, default "Last update").

## Decision

- A compact outlined **sort button** in the screen header (next to Sidekick and Refresh) orders the playbook
  sections: **Name (A-Z)**, **Last activity** (the former behavior), **Status** (waiting, working, failed, done,
  paused, seen; the best run of the playbook counts) and **Start time** (newest run first). Ties fall back to the
  name, then the playbook id, so every order is total.
- **Default: Name (A-Z).** The previous order was activity, but it is exactly what moved under users; nobody can
  rely on it as a position. Last activity stays one click away.
- "Needs you" follows the sections' order, so it does not jump either.
- **Persistence**: a host-scoped plugin setting (`overview`, `{ sort }`, via `registerSettings` / `useSettings`), the
  only persistence the plugin API offers (the client has no local storage). A pick shows at once and is then saved.
- Comparators are pure functions in `shared/sort.ts` with tests. Only the order changes: a sort never hides a
  playbook or run, and with Name or Start time a section does not move when its runs change state.
- The per-playbook sort of runs inside a section is unchanged (and not persisted).

## Consequences

- The plugin now registers a setting on the host; the sort is shared by every client of that host.
- Until the setting has loaded, the screen shows Name; a pick made before is kept.
- Under Last activity and Status, sections still move as data changes: that is what those orders mean.
