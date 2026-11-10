# Pilot follow-ups: preamble, canceled worktrees, compact playbook views, loop feedback

Status: Accepted

Refines `2026-11-09-isolation-worktree.md` (it is not superseded; the cleanup rule is clarified).

## Context

A pilot of two parallel isolated runs showed isolation works, and four frictions.

## Decision

- **Preamble**: every agent of an isolated run is also told never to use `git stash` (the stash
  stack is shared by the original checkout and every worktree: use a temporary WIP commit) and never to
  run `git checkout`, `git reset` or `git pull` in the original checkout.
- **Cancel vs fail**: `workspace.keep_failed` applies to FAILED runs only. A canceled run is an intentional
  end, so its worktree is removed like a completed run's. The safety rules still apply to it: a worktree with
  uncommitted changes, or after an isolation guard violation, is kept, and a branch with commits on no remote is
  kept. The code already did this; the ADR text now says it and a test pins it.
- **Compact views**: `list_playbooks` and `validate_playbooks` take `view: "compact" | "full"` (default
  `compact`) and `playbookId`. Compact gives per playbook `id`, `valid`, `errors`, and for valid ones `title`,
  `hidden`, input names, step ids and after-task ids; `results[].valid` is unchanged. `full` is the former
  output. Playbooks have no warnings today, so no warning count is returned. A `playbookId` returns the full
  description of that playbook.
- **Loop feedback**: no semantic change. `complete_step`'s `summary` is the loop feedback; the `unknown output`
  error and the `request_gate` missing-`summary` error say so, and the README and skill document it.

## Consequences

- Callers that read the former full output of `list_playbooks`/`validate_playbooks` must pass `view: "full"`.
- `request_gate`'s `summary` is optional in the schema (required in practice) so the error is specific.
