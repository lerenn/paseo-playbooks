# Remove `rate_limits.mode`

## Status

Accepted. Supersedes the mode (decision 4) of `2026-11-20-dynamic-rate-limits.md`, and the step-mode remarks of `2026-11-20-rate-limiting.md` and `2026-11-21-pause-admitted-runs-to-fit-pace.md`. The location and name of the settings (`rate_limits` of the user config only; `rate_limit.priority`) are superseded by `2026-11-23-quota-limits-in-defaults.md` (`quota_limits`, also in `defaults/main.yaml`; `quota_limit.priority`).

## Context

`rate_limits.mode` chose between `playbook` (admit a whole run against its estimated cost, then pause admitted runs between steps to fit the pace) and `step` (hold runs between steps, release them one step at a time, so runs interleave). With the pace pause and the immediate re-check, `playbook` covers the goal of step mode (the quota decides how much runs) without interleaving runs, which wastes context and worktree switches. Keeping both doubled the code paths, the reservations and the tests.

## Decision

- The setting is removed; the behaviour is the former `playbook` mode only: whole-run admission against the estimated cost from history, admitted runs paused between steps to fit the pace and resumed one by one, held and paused runs re-checked at once when capacity frees.
- The step-mode path is deleted: per-step headroom admission, per-step reservations (all reservations are now per run) and the hold between steps for lack of headroom.
- A `config.yaml` that still sets `rate_limits.mode` (any value) loads normally: the key is ignored and a note is logged once. It is not a validation error.
- The `rateHold` kinds are unchanged: each one is still produced (`headroom`, `pace`, `quota`, `steps`, `playbooks`).

## Consequences

- Users who ran `mode: step` now get whole-run admission; their runs no longer interleave step by step.
- Less code and fewer states to reason about; docs and tests describe one behaviour.
- A minor version bump, since a setting disappears.
