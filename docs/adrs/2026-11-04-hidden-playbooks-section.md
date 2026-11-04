# Hidden playbooks section

Status: Accepted

Supersedes the "the Playbooks panel leaves it out of its list" rule of
`2026-11-03-hidden-playbooks.md`.

## Context

A playbook with `hidden: true` was left out of the panel entirely. The only way to start
one, or even to see its graph, was to ask an agent to call `start_playbook`.

## Decision

- Hidden playbooks are listed in a "Hidden playbooks (N)" section at the bottom of the
  panel. It is collapsed by default; whether it is open is kept per tab. It is not shown
  when there are no hidden playbooks.
- Cards in that section are ordinary cards, Start button included. A short note says they
  are meant as sub-playbooks or after-tasks.
- A hidden playbook with runs of its own, or with validation errors, stays in the main
  list as before, so a run waiting on a gate or an error is never tucked away. Once its
  runs are archived it moves back into the section.
- Everything else from `2026-11-03-hidden-playbooks.md` is unchanged: `hidden` is display
  only, and `list_playbooks` still returns it.

## Consequences

- No format change. The main list stays as short as before, and hidden playbooks are
  reachable from the UI.
