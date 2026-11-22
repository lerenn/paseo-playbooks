# Manager auto-recovery on a quota block, and fresh new workspaces

Status: Accepted

## Context

- A run whose manager hit its provider's quota stayed blocked (`managerQuotaBlocked`) with its work pending until a
  human called `recover_manager`, which refuses without a confirmed quota exit and has no background retry
  (see `2026-11-02-design.md`).
- A run started with `newWorkspace` branched its workspace off the root checkout's local branch, which can be behind
  origin. A script the playbook references, present on origin, was then missing and the step failed with a bare ENOENT
  although the pinned definition was current.

## Decision

- **Automatic recovery.** While a run is active, unpaused, has its manager quota-blocked and has pending work (queued
  wake-up, recovery prompt or a ready step), a tick phase calls `recoverManager` by itself. It is driven by the existing
  15 s limit timer (which now also runs while a manager is blocked), with a per-run backoff (30 s, doubling, at most
  10 min) and the shared usage cache, so the usage endpoint is not read more often than before. The retry marks the
  blocked target exhausted only if it is not marked yet, and clears the mark when the usage reading shows headroom
  for that provider/model; without a reading the target comes back when `providers.exhausted_for` ends. The manual
  `recover_manager` path is unchanged.
- **Config, block form.** `manager_recovery: { retry: true, fallback: { provider, model } }` in the playbook
  defaults, a playbook, or the user `config.yaml` (precedence: playbook, defaults, user config, built-in default).
  `retry` defaults to true; `fallback` is opt-in and adds one more target after the manager's chain, for the
  automatic path and for a manual `recover_manager { model }`.
- **Visibility.** A recovery by the plugin writes a `manager_recovered` history entry and emits
  `run.manager_recovered` (`fromManagerId`, `managerId`, `target`, `retargeted`).
- **Fresh workspaces.** Right after creating a `newWorkspace` workspace, the plugin fetches `origin/<branch>` of the
  root checkout's branch and runs `git merge --ff-only` in the new workspace. It never fails the run: when that is
  impossible (offline, diverged) it logs a note.
- **Fail fast on scripts.** Before spawning a script step, a missing script file fails the step with
  `script file not found: <path> (workspace <dir>, head <sha>)`.

## Consequences

- A quota-blocked run resumes without a human once headroom returns; users who dislike this set `retry: false`.
- A configured fallback may move a manager to another provider (new conversation, same run state), so it is off by default.
- New workspaces cost one extra `git fetch` and are current with origin.
- No change to run state or the agent tools' contract beyond the new `managerRecovery` playbook field (defaults to unset)
  and the new event type.
