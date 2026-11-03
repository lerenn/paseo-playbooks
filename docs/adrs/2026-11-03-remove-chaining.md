# Remove chaining: playbooks combine only as parent and child

Status: Accepted

Supersedes decisions 34 (chaining) and 37 (chained runs) of `2026-11-02-design.md`.

## Context

There were two ways to combine playbooks. `next:` offered the manager another playbook to
start once a run completed, as a separate top-level run. A sub-playbook step
(`playbook: <id>`, decision 49) included one playbook in another as a block of the same run.

Having both caused confusion. When a `ticket-to-prod` run ended early, its coordinator
started `release` by hand as its own top-level run, and the panel showed that run under
Release instead of inside Ticket to prod. Chaining also only fired on `completed`, so
using it for work that must follow every run (a retro, for example) did not run after
failed or canceled runs. And a `next` on a nested playbook was silently ignored.

## Decision

- The `next` key is removed from the playbook format. A playbook that still has it fails
  validation with a message pointing to sub-playbook steps.
- Runs no longer offer a chain: `complete_step`, `get_run`, `list_playbooks`, the manager's
  wake-up notes and the panel no longer mention one.
- The manager prompt tells the manager not to start a follow-up playbook unless the human
  asks.
- To run playbook B after playbook A, write a parent playbook that includes both as
  sub-playbook steps. One run, one graph.

## Consequences

- Repositories with `next:` in a playbook must remove it; the playbook is invalid until
  they do.
- Every multi-playbook flow is visible as one graph in the panel, under the parent.
- Work that must happen after every run, whatever its outcome (such as a retro), needs a
  parent/child-shaped mechanism. That is a separate decision.
- Stored runs keep a `next` field in their playbook snapshot; it is ignored when read.
- Breaking format change: minor version bump (0.4.0).
