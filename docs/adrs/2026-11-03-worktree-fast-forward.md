# New worktrees fast-forward to the latest origin/main

Status: Accepted (#19)

## Context

A Paseo worktree branches off the local `main`, which is often behind `origin/main`.
Agents then started from stale code and opened pull requests that needed a rebase.

## Decision

`paseo.json` has a `worktree.setup` command. When a new worktree's `HEAD` is the local
`main` or `origin/main`, it fetches `origin main` and fast-forwards with
`git merge --ff-only`. A worktree branched from anything else is left alone. If the fetch
fails (offline), it keeps the original commit and says so.

## Consequences

- Worktrees started from `main` begin on the latest merged code.
- Creating a worktree needs network access to be up to date, but does not fail without it.
