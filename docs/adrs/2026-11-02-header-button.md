# A Playbooks button in the workspace header

Status: Accepted (#13). Extends decision 6 of `2026-11-02-design.md`.

## Context

Decision 6 made the Playbooks panel, in the right-hand Explorer, the plugin's only UI. A
gate waiting for a human was easy to miss when that panel was closed or another workspace
was open.

## Decision

- Every workspace that has playbooks gets an icon-only Playbooks button in its header. It
  opens or focuses the Playbooks tab.
- The button shows a dot in the theme's warning colour while a run in that workspace waits
  for a gate decision.
- The client takes the workspaces from a subscribed workspace list, and a `header.state` RPC,
  polled every 10 s, says which ones have playbooks and which have a waiting gate.

## Consequences

- Waiting gates are visible from any workspace's header, without opening the panel.
- One more client surface and one more polled RPC; the panel remains the only place to act
  on a run.
