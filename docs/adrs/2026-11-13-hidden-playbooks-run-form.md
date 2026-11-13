# Hidden playbooks stay out of the Run Playbook form

Status: Accepted

Extends `2026-11-04-hidden-playbooks-section.md`.

## Context

`hidden: true` marks a playbook meant only as a sub-playbook or after-task. The Playbooks panel
tucks it away, but the Run Playbook form's dropdown still listed it next to the playbooks a human
is meant to start.

## Decision

- The Run Playbook form's dropdown (and the choice of projects that can run something) leaves
  out hidden playbooks.
- Hiding stays about pickers only. A hidden playbook is still validated, usable as a
  sub-playbook, fan-out or after-task, startable by name with `start_playbook` and from the
  panel's "Hidden playbooks" section, and `list_playbooks` still returns it with `hidden: true`.
  Its runs stay in the Runs tab, the graph and the analytics.

## Consequences

- No format change. A project whose only playbooks are hidden no longer shows the Run Playbook
  button; they remain reachable from the panel section.
