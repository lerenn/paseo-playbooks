# Dynamic capacity from quota headroom

## Status

Accepted, except the manual `rate_limit.estimate` of decisions 2 and 5, superseded by `2026-11-21-remove-rate-limit-estimate.md`. Supersedes decisions 2, 3 and the "usage at or above the ceiling holds" rule of 4 in `2026-11-20-rate-limiting.md`.

## Context

The fixed `steps` and `playbooks` counts made users guess how much work their quota could carry, and the pacing only said "stop" or
"go". What users want to say is "use my quota at a steady pace"; how many runs fit then follows from the quota left and from what the
work costs.

## Decision

1. **Headroom.** Per provider window: the pace ceiling (`usable_percent` × elapsed / window length, as before, never above `usable_percent`,
   the tightest window and provider winning) minus current usage minus what started work still has to use. Work starts while the headroom
   covers its estimated cost; the rest is held. The parallelism is the result, not a setting. `steps` and `playbooks` stay only as
   optional hard caps on top (unset = none). A window above `usable_percent` holds as a quota hold until it resets, as before.
2. **Cost estimate.** Quota points (percent of the window) per agent step, per playbook, provider and window: the average over the
   playbook's finished steps, kept in `rate-history.json` in the plugin data folder, or the playbook's manual `rate_limit: { estimate: N }` (points per
   step), which wins over history. With neither (no measure yet) the playbook is **not paced by cost**: it starts without a headroom check and reserves 0, while the
   hard cap (`usable_percent`) and the "quota data unavailable" hold still apply; there is no default share. A run costs steps remaining × per-step cost, capped at `usable_percent` so a big run is still admitted some day. Each
   usage reading's increase on a window is shared among the agent attempts running on that provider in the interval, by overlap in
   time (usage from outside the plugin lands on them too: a known imprecision).
3. **Reservation.** Work that starts reserves its estimated cost; the part not yet seen in the readings (estimate minus the increase
   attributed to it) counts against the headroom. A reservation of ended work stays until the next successful reading, then goes.
4. **Mode** (`rate_limits.mode`, global). `playbook` (default): a whole run is admitted when the headroom covers its estimated total
   cost; an admitted run is never evicted for a higher-priority one and is held between steps only when its quota is exhausted (a window at
   `usable_percent`) or its data is unavailable. `step`: runs are held between steps; whenever the headroom covers one step, held runs are
   released by priority, then oldest first, so runs may interleave.
5. **Priority.** `rate_limit: { priority: N, estimate: N }` (priority a whole number, default 0; estimate optional, see 2) on the playbook or in `defaults/main.yaml`, overridden
   per run by `start_playbook`'s `priority` (stored on the run). Higher first, ties oldest first, in both modes and for the optional
   playbook cap (which also keeps runs already started ahead). Waiting work is taken in that order and each takes its cost from the headroom;
   one that does not fit blocks lower work on the same provider, so a large run is not starved by small ones.
6. **No usage report.** A provider with no usage entry, not available, or no window is not paced. With pacing on, the run gets a
   `rateNote` (in `get_run` and the run's menu) and the plugin logs it once per provider.
7. **Hold data.** `rateHold` gains kind `headroom` and `estimatedCost`, `headroom`, `position` (1 = next) and `priority`; `run.held` carries them.
   Everything else of the earlier ADR stands: never interrupt a running step, the plugin resumes by itself, `run.held`/`run.released`,
   "Continue anyway" (for quota and headroom holds), Sidekick and manager awareness.

## Consequences

- With pacing off nothing is paced; the caps still work as before (with priority order).
- A playbook's first runs are not paced by cost (the first measure comes from them), so they may overshoot the pace; set `rate_limit.estimate` to avoid that.
- Attribution by time overlap is approximate when several steps run at once or the user also spends the quota.
- An admitted run keeps its unused estimate reserved until it ends, so it can hold back others for a while.
- Format: one new playbook block, `rate_limit` (`priority`, `estimate`), and one new `start_playbook` argument; run files get `priority` and `rateNote` with defaults, so older ones load.
