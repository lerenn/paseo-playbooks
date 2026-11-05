# Project and workspace filters on the Playbooks screen, from runs only

Status: Accepted. Supersedes the chips of `2026-11-05-sidebar-screen.md`.

## Context

The Playbooks screen showed a chip for every workspace with playbooks. Every worktree of a
repository has its playbooks, so the row listed dozens of conversations, most with no run.

## Decision

- Two levels of chips. The first lists projects; picking one shows a second row with that
  project's workspaces (conversations). Each chip shows its pending gates.
- Chips come from the runs on screen only: active runs, plus finished ones with **Show done**.
  A project or workspace without such a run is not listed.
- `overview.state` takes only `includeDone` and returns the runs. It no longer checks which
  workspaces have playbooks.

## Consequences

- The filters stay short, and they change as runs start and end.
- The screen no longer shows workspaces where a run could be started; the panel does that.
