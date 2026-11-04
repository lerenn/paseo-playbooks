# Hidden playbooks

Status: Superseded by 2026-11-04-hidden-playbooks-section.md (panel listing only)

## Context

Some playbooks only make sense inside another one: a retro used as an after-task, or a
sub-playbook that needs its parent's outputs. The panel lists every playbook with a Start
button, which invites starting them alone.

## Decision

- A playbook may set `hidden: true` (default `false`). The Playbooks panel leaves it out of
  its list.
- Hiding is display only: the playbook is still validated, still usable as a sub-playbook
  or after-task, and still startable with `start_playbook` (`list_playbooks` returns it with
  `hidden: true`, so the manager can tell it is not meant to be started alone).
- A hidden playbook that has runs of its own still gets a card, so those runs stay visible.
- A playbook with validation errors is always listed, so its errors are shown.

## Consequences

- Additive format change: existing playbooks are unaffected.
