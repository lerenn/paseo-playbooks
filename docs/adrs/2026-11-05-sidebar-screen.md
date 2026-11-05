# A Playbooks entry in the sidebar, with an all-workspaces screen

Status: Accepted. Extends `2026-11-02-header-button.md` and supersedes its "the panel remains
the only place to act on a run" for gate decisions.

## Context

The Playbooks panel and the header button work one workspace at a time. With runs in several
workspaces, there was no single place to see what waits for a human or how far each run has
gone.

## Decision

- A **Playbooks** row in Paseo's left sidebar (`addSidebarHeaderItem`) opens a **Playbooks
  screen** (`addScreen`). The row shows, in the theme's accent colour, a badge with the number
  of gates pending on the host.
- The screen covers every workspace of the host:
  - a summary line (need you, working, paused, and done when shown);
  - a chip per workspace that has playbooks or runs, with its own pending count, to filter;
    and a **Show done** chip that adds finished runs (hidden by default);
  - **Needs you**: one row per pending gate. **Review** opens the gate's choices in place
    (the panel's `GateActions`), so a gate can be decided from the screen;
  - one section per playbook, with its main-graph steps as columns in declared order, plus
    **Done**, and one row per run with a progression line. A ring marks each live step (several
    for parallel steps); after a `goto` the ring moves back.
- Two RPCs: `overview.state` (workspaces with playbooks, and the runs not archived, active only
  unless `includeDone`), polled every 5 s while the screen is open; `overview.needs-you` (the
  badge count), polled every 10 s.

## Consequences

- Gates can be decided from two places, the panel and the screen. Both use the same component
  and RPC, and a gate decided twice reports "already decided".
- Pausing, cancelling, restarting and the graph stay in the panel; the screen links to the
  workspace and to the Playbook Manager.
- Two more polled RPCs. `overview.state` checks each workspace for playbooks on every poll,
  like `header.state`.
