# Steps carry an optional human-facing description

## Status

Accepted.

## Context

A playbook has a `description` (Start form, `list_playbooks`), but a step only has a `title`. Someone who opens a step's sheet (for example "Wait for blocking PRs · Script") sees what it runs but not why the step exists or how it works, and the Sidekick or an LLM reading `get_run` cannot answer that either.

## Decision

1. Every step and after-task accepts `description`: a plain string, trimmed, non-empty, at most 2000 characters. It is flat on the step because it describes the step itself, like `title` (see the extend-playbook-format skill); it is not a feature with options.
2. It is for humans only. It is never rendered into an agent's prompt or brief.
3. The step sheet shows it at the top, above the kind-specific sections; the graph node's (i) opens that sheet, so no new surface. Nothing is shown when it is absent.
4. `get_run` (compact and full) and `list_playbooks` (`view: full`) show it per step as `description`, left out when absent. The Playbooks screen's step summaries carry it too.

## Consequences

- Append-only: no playbook without it changes behaviour; run files from older versions load (the field is optional).
- Minor version bump. Text is plain (no markdown), like the playbook description.
