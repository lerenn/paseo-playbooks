# workspace.title: a template for the title of a run's workspace

## Status

Accepted. Extends the workspace title of `start_playbook` (`workspaceName`, ADR 2026-11-02 design).

## Context

A run's new workspace was titled `<playbook title>: <first input>`, or the `workspaceName` the caller
passed. Fan-out children could not be named by their callers, and playbook authors could not shape the
title (`Ship to all envs: OPS-562` where `Ship OPS-562` was wanted).

## Decision

- New option in the existing `workspace` block: `workspace: { title: "Ship {ticket}" }`, in a playbook or
  `defaults/main.yaml` (the playbook wins). Not a flat field.
- `{name}` is filled from the run's inputs (after defaults). Precedence: an explicit `workspaceName`
  (`start_playbook`, the start form), then `workspace.title`, then the old default.
- If a placeholder names an input the run does not have, or one that is empty, the whole template is
  skipped and the old default is used: a title never fails a run. The result gets the existing trim
  (one line, 80 characters).
- One function (`workspaceTitle`) computes the title for every run that gets a workspace: `start_playbook`,
  the start form and cards, fan-out children (from their own inputs), `replace_child`. Restarts keep the
  existing workspace and so its title. A singleton's shared pipeline workspace keeps the playbook title.
- `validate_playbooks` refuses a playbook's own `workspace.title` naming an undeclared input. A template
  in `defaults/main.yaml` is not checked (inputs differ per playbook); it falls back at run time.

## Consequences

- Run state's `playbook.workspace` gains `title` (default null), so older runs load.
- Literal braces of the form `{word}` cannot be used in a template.
