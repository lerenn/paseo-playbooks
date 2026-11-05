# Status colours, motion and "seen" runs on the Playbooks screen

Status: Accepted. Supersedes the "chips come from the runs on screen" rule and the
`includeDone` input of `2026-11-05-overview-project-filters.md`.

## Context

Every run on the Playbooks screen looked the same: a blue ring and spinner icon that did not
move, whether it worked, waited for a decision or had failed. A finished run could not be told
apart from one already looked at. Projects and workspaces with only finished runs had no chip.

## Decision

- Each run has a tone, used for its icon, its status text, the filled part of its line and its
  ring: blue while working, yellow while waiting (a gate, or a free `concurrency` slot), green
  when done and not opened, grey when done and opened or paused, red when failed or canceled.
- While a run works or waits, its icon moves (a spinner turns, a waiting dot pulses) and the
  ring on its live steps pulses. Reduced motion turns this off.
- Runs get a `seenAt` field (default null). Opening a finished run from the screen (its row, its
  manager or its workspace) sets it through a `runs.seen` RPC. A restart clears it.
- `overview.state` returns every run that is not archived. The screen lists them all except done
  runs already opened, which **Show done** adds. Chips are built from all those runs, so a
  project or workspace with a working, waiting, failed or done run is listed.

## Consequences

- One more field in the run state (defaulted, so older runs load unchanged) and one more RPC.
- "Seen" is per host, not per device, and only the screen sets it; the panel keeps its own
  read state per tab.
