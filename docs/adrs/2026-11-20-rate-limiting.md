# Rate limiting of playbook steps

## Status

Accepted. Decisions 2 and 3 (the fixed step and playbook counts as the capacity) and the hold decision of 4 are superseded by `2026-11-20-dynamic-rate-limits.md`: the counts are now optional hard caps, and quota headroom decides what starts. The rest (settings block, quota data, "Continue anyway", never interrupt, awareness, UI) stands.

## Context

Several runs, in several projects, can start many agent steps at once and spend a provider's quota (a 5-hour or a
weekly window) faster than the user wants. The plugin already reads provider usage (`2026-11-13-usage-aware-fallback.md`),
but only to choose a target, not to slow work down. Users need global limits and a pace for the quota, without
losing or interrupting work.

## Decision

1. **Settings.** A global block in the user config (`config.yaml`, read when needed, so a change applies without a
   reload), off by default. It is not part of the playbook YAML (a user setting, not a playbook's), but it follows the block rule:
   `rate_limits: { steps: 4, playbooks: 2, quota: { pacing: true, usable_percent: 97, refresh_interval: 5m, max_age: 30m } }`.
   `steps` and `playbooks` unset mean no limit; `quota.pacing` defaults to `false`.
2. **Step limit** (all projects): at most `steps` agent and script steps running. A further step is not started and its
   run is held until a step ends. Gates, hand-offs and fan-out steps do not count and are never held (a fan-out step
   waits for runs that need the capacity).
3. **Playbook limit** (all projects): at most `playbooks` runs admitted. The admitted ones are the oldest active runs
   (fan-out children belong to their parent's admission), so a hold is stable and never alternates between runs. When the
   limit drops, a running step is never interrupted: the run that is not admitted is held after its current step ends,
   and stays held until the limit rises or an admitted run ends.
4. **Quota pacing.** For each provider the run's agent steps use, and for each provider-wide usage window, the
   cumulative ceiling at elapsed time `t` is `usable_percent * t / window length` (97% over 100 h = 0.97 points an hour).
   Usage at or above the ceiling holds new steps until the ceiling catches up; at or above `usable_percent`, until the
   window resets. The tightest window wins, and the tightest provider wins for a run that uses several. The window length is read
   from its id or label (`five_hour`, `5h`, `weekly`); a window whose length is unknown only has the hard cap. Script steps are
   not paced (they use no provider).
5. **Quota data.** Read from the existing usage endpoint (`providers.listUsage`), kept per provider with the time of the
   last successful read. Younger than `refresh_interval`: used. Older but under `max_age`: still used while one
   background refresh runs (single-flight). Older than `max_age`: new steps are held with reason "quota data
   unavailable" and the read is retried with a backoff of 1, 2, 5, 10 minutes (then every 10); a held run is released as soon as a
   read succeeds. A failed read never updates the readings. The endpoint returns every provider at once, so one read serves all of them.
6. **Continue anyway.** A manual, time-limited override per provider (`rate_limits.override_quota` RPC; 1 hour by default, at
   most 24 hours; kept in memory, so a plugin reload ends it) lets steps start despite the pacing. It does not lift the step or playbook limits.
7. **Never interrupt.** Only new steps are held (between steps and at admission); a running step, a retry's agent and a gate are untouched.
   The plugin lifts every hold itself (the tick, a 15 s timer while any run is held, and a successful usage read): no agent action is needed.
8. **Awareness.** Sidekick and managers are not held. A hold is recorded in the run (`rateHold`: kind, reason, provider,
   window, since, retryAt; default `null`, so older run files load) and in its history (`run_held`, `run_released`). The manager is
   told when it starts and when it ends, `get_run` shows `rateHold`, `start_step` is refused with the reason, and two events, `run.held` and
   `run.released`, are emitted; both are in the Sidekick's default `watch`. Prompts tell them not to start, retry, restart or cancel because of a hold.
9. **UI.** The run tab says "on hold" and its menu says why, the provider and window and when the plugin looks again, with
   "Continue anyway" for a quota hold; the Playbooks screen status line says it too. An open human gate always shows first and is never hidden by a hold.

## Consequences

- With the defaults nothing changes.
- A run that waits at a human gate keeps its place in the playbook limit.
- A run's providers are those its agent steps name (the default provider when a step names none); the provider chosen by
  fail-over later is not paced in advance.
- The panel shows the hold of the run, not a list of all limits; the settings are edited in `config.yaml`.
