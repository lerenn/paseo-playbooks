# Gitlink guard: staging rule and a post-step check for deleted submodule entries

Status: Accepted

Refines `2026-11-09-run-isolation-worktree.md` (it is not superseded).

## Context

In a monorepo worktree where submodule directories were empty or absent, a playbook agent's commit staged the
removal of all 44 submodule gitlinks (mode 160000), consistent with a blanket `git add -A` or `git commit -a`.
The PR merged and broke main until the entries were restored.

## Decision

- **Rule**: every step agent is told: never run `git add -A`, `git add .` or `git commit -a`/`-am`; stage by path
  and check `git diff --cached --stat`; never stage the removal of a submodule entry; if
  `git diff --cached --summary` shows `delete mode 160000`, `git restore --staged` it. It is in the isolation
  preamble (manager and agents of isolated runs) and in the step agent's system prompt otherwise (once either way).
- **Guard**: after each step of an isolated run (the same point as the original-checkout guard, so also the last
  step), the plugin compares the worktree's index with the run's base commit. Any submodule entry the branch
  deletes (committed or staged) fails the step with a `gitlink_violation` event and a summary naming the paths;
  the manager is told how to restore them.
- **Setting**: `isolation: { allow_gitlink_removal: false }` (default `false`, also in `defaults/main.yaml`);
  `true` turns the guard off for playbooks that remove submodules on purpose. The plugin has no per-step
  "declared intent", so the setting is the only way to declare it.

## Consequences

- `Isolation` in run state gains `allowGitlinkRemoval` (default `false`; older run files load).
- Runs without isolation get the prompt rule only.
