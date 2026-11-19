# Faster panel loading: the Sidekick list in parallel, definitions after a head start

Status: Accepted

## Context

Opening the Playbooks screen with the Sidekick column was slow on a big installation (about 25 active runs,
many archived, a few hundred workspaces, one Sidekick per project). Measured on a synthetic setup:

- `overview.state` is already light (`summarizeRun`): 25 runs serialise to about 46 KiB in under 1 ms. No change.
- Analytics and Profiles are only fetched when their tab is opened. No change.
- The Sidekick chat already reads only the last 200 timeline items on open. No change.
- `sidekicks.list` (the column's tabs) asked each project one after the other (workspace lookup, files read,
  agent refresh): with 30 projects and 20 ms per agent lookup it took 623 ms, growing linearly with the projects.
- At open the screen also sent one `playbooks.list` per project, all at once, for the Run Playbook button
  (about 19 ms of file reads each, 561 ms for 30 projects), competing with the Sidekick list on the same server.

Not measurable here: the client's time to first paint (it depends on the host); the figures are server-side.

## Decision

- `Runtime.sidekickProjects` handles the projects concurrently (and the agent refresh with the files read of
  one project concurrently); the result keeps the input's order and still leaves out unknown workspaces.
- The screen lists the projects' playbook definitions 1.2 s after it mounts instead of at once; the Run
  Playbook button shows "loading" until then. The Sidekick column and the runs do not wait for either.

## Consequences

The Sidekick list went from 623 ms to 22 ms in the benchmark (`server/sidekick.test.ts`). The Run Playbook
button becomes usable about a second later. No RPC contract changed, so older clients keep working.
Not done, as the measurements did not justify it: a lighter overview payload, lazy tabs (already lazy),
Sidekick history pagination (already limited), an analytics cache.
