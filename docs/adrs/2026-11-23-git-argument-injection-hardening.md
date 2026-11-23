# Git argument injection hardening

## Status

Accepted

## Context

`isolation.base` (and `singleton.branch`) only had to be a non-empty string, and the value reached `git fetch`
with no `--`, so a value such as `--upload-pack=<script>` was read by git as an option. `validate_playbooks` is
preapproved and can point at any local directory, so a prompt-injected agent could run a script without a
permission prompt. valentin9 reported it in issue #262 and fixed the three `git fetch` calls with `--` in PR #261.
The same pattern was in `freshenCheckout`, and a ref reached `git rev-parse`, `git archive` and `git worktree add`
unguarded. Issue #262 proposed three further steps.

## Decision

- The loader rejects an `isolation.base` or `singleton.branch` that is not a valid branch name (the rules of
  `git check-ref-format --branch`, checked in `server/branch-name.ts`) or that starts with `-`. `validate_playbooks`
  reports it before any git call.
- One `fetchBranch` helper in `server/git.ts` does every fetch of a branch from origin: it validates the name and
  adds `--`. `resolveCommit` and `exportPaths` reject a ref starting with `-`; `git worktree add` gets `--` before
  its path. `createWorktree` and the singleton pipeline check their base again, since it can also come from
  origin's HEAD.
- Making `git()` private (step c of the issue) is not done: it is used by many call sites and by `runtime.ts`, so
  it is a large refactor for little gain once the ref arguments are guarded at their source.

## Consequences

- A playbook with such a base no longer loads; the error names the field and the problem.
- New git calls that take a ref from a playbook, a run input or a tool argument must go through these helpers or
  put `--` / a fixed prefix in front of the value.
- Credit: valentin9 (issue #262, PR #261).
