# Quota limits: renamed `quota_limits`, settable in the repository defaults

## Status

Accepted. Supersedes the config location and the key names of `2026-11-20-rate-limiting.md`, `2026-11-20-dynamic-rate-limits.md`, `2026-11-21-pause-admitted-runs-to-fit-pace.md` and `2026-11-21-remove-rate-limit-mode.md` (`rate_limits` in the user config only; `rate_limit.priority`). Their behaviour (headroom, pace, holds) is unchanged.

## Context

The quota limiter was configured only in the user's `config.yaml` under `rate_limits`. A team that shares a repository or a profile
cannot ship "pace at 90%" with it, and the name said "rate" for what is a share of a provider's usage quota. Other repository-wide
behaviour (`auto_archive`, `manager_recovery`, `warden`) already lives in `defaults/main.yaml`.

## Decision

1. **Names.** The user-config block `rate_limits` becomes `quota_limits`, same keys: `quota.pacing`, `quota.usable_percent`,
   `quota.refresh_interval`, `quota.max_age`, `steps`, `playbooks`. The per-playbook `rate_limit: { priority }` becomes
   `quota_limit: { priority }` (playbook or defaults; `start_playbook`'s `priority` still overrides per run). Only config keys are
   renamed: run state (`rateHold`, `rateLimit`), the events `run.held` / `run.released`, the hold kinds and `rate-history.json` keep their names.
2. **Aliases.** `rate_limits` (config or defaults) and `rate_limit` (playbook or defaults) keep working and log a one-time deprecation
   note naming the new key. When both are given, the new key wins as a whole and the old one is ignored. The legacy block keeps its legacy
   meaning (see 5).
3. **Where.** `quota_limits` is accepted in the user config and in `defaults/main.yaml` (a repository's or a profile's). It is refused in a
   playbook (a playbook only has `quota_limit: { priority }`). In defaults it is validated strictly (a bad value is a load error naming the
   field); in the user config a bad value falls back to the default, as before.
4. **Precedence.** Field by field: the folder's `defaults/main.yaml`, then the user config, then the built-in defaults. This is the order
   `auto_archive`, `manager_recovery` and the other defaults already follow (playbook, then defaults, then user config, then built-in), so the
   limiter does not invent a second order. A user who wants the last word on a machine edits the defaults of the folder or removes its entry.
5. **Enabling.** `quota.pacing: true` stays the switch. `quota_limits` also turns pacing on by itself when `quota.usable_percent` is set and
   `pacing` is not, so `quota_limits: { quota: { usable_percent: 90 } }` paces at 90%; `pacing: false` turns it off. The legacy `rate_limits`
   keeps needing `pacing: true`, so no existing setup starts pacing. Without any `quota_limits`, pacing is off.
6. **Per run, not global.** The quota is shared across projects but defaults are per folder, so the effective limits are resolved for each
   run from its own playbook folder (the defaults are copied into the run's playbook when it starts, like the other defaults): the run's
   pacing flag, `usable_percent` and the reading's freshness settings decide its own admission, hold and pause. The usage readings, the
   reservations, the measured costs and the queue stay global per provider; the headroom of a window is read through each run's own
   `usable_percent`, and the points taken by earlier runs of the queue are subtracted whatever their percent. The hard caps `steps` and
   `playbooks` are global counts of all runs; each run is gated by the cap of its own resolved config, so a run from a folder with no cap is
   never held by another folder's cap, and a run whose folder sets a cap is held when all runs together reach it.
7. **Reload.** A change to `defaults/main.yaml` is picked up like every other default: the playbooks are loaded again and the runs started
   afterwards carry it (a run already started keeps the limits it started with). The user config is still re-read every 5 s, no reload.
8. **Format.** New schema `RawQuotaLimitsSchema` (strict block, same shape as the config) in `RawDefaultsSchema`; the playbook's loaded
   `quotaLimits` (the fields the defaults set; `{}` for runs from before it) is part of run state.

## Consequences

- A profile can carry its pacing: `quota_limits: { quota: { usable_percent: 90 } }` in its `defaults/main.yaml` is enough.
- Two folders with different `usable_percent` share one quota fairly in queue order but each sees the headroom through its own percent.
- Existing configs keep working; the deprecation note is printed once per process and per old key.
- Precedence differs from "the machine owner always wins": a folder's defaults beat the user config for the fields they set. This was chosen for consistency with the other defaults.
