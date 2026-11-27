# Refresh sidebar badges with a compact workspace view

## Status

Accepted.

## Context

The workspace-badges ADR (2026-11-24) wired the sidebar to the same full run list as the
Playbooks screen. In issue #355, refreshing that list while only the sidebar needed it
accounted for about half of the reporter's mobile traffic and delayed chat loads.

## Decision

Use one refresh loop per host and choose its request based on what is mounted. With the
Playbooks screen open, use `overview.state` and derive workspace badges locally from its
run summaries. With only workspace badge rows mounted, use `overview.badges`, which
returns the host's pending gate count and the computed badges of marked workspaces.
With only the sidebar count visible, use `overview.needs-you`.

Derive the badges with the same mapping in both runtimes. The daemon reads non-archived
runs directly for the compact response and skips calculating quota priorities. This
supersedes the shared full-run-list refresh in the workspace-badges ADR.

## Consequences

Sidebar-only refreshes send one compact entry per marked workspace. Agent-event batching
and the 60-second fallback still refresh the sidebar, including elapsed-time warnings and
badges expiring 24 hours after a run ends.
