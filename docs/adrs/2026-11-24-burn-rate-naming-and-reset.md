# Burn rate: naming, the Burn rate limiting rename, surfaces, and a hard reset

## Status

Accepted. Names and extends `2026-11-24-quota-per-hour.md` (its status line points here). Renames the tab and feature defined in `2026-11-23-quota-limitation-tab.md` (and `2026-11-23-quota-limitation-project-rows.md`, `2026-11-23-quota-tab-no-held-block.md`): only the label changes, the tab id `quota`, the RPC `quota.limitation`, the config keys (`quota_limits`) and every identifier stay.

## Context

The metric added by the previous ADR (quota per hour of agent time) needed a user-facing name, the quota surfaces still said "cost per step", and a playbook or step that changed a lot kept a stale learned history with no way to clear it.

## Decision

- **Naming.** The metric is *Burn rate*: quota points (percent of the usage window) per hour of active agent time, shown `0.6%/h` (fr *Taux de consommation*, zh-CN 消耗率). *Quota per run* (quota per attempt × attempts per finished run) is a separate figure; *Throttle*, *Allowed so far* and *Max usable quota* are unchanged. In `get_analytics`, `quotaRates` carries `burnRate` and `quotaPerRun` (renamed from the first release of these fields, a day old); `pointsPerStep`, `steps`, `agentMs`, `lowConfidence` are unchanged.
- **Feature rename.** The tab, its heading, the "+" menu entry and all user-facing and current documentation text say *Burn rate limiting* (fr *Limitation du taux de consommation*, zh-CN 消耗率限制) in place of "Quota limitation", "quota limiting" and "quota limits". The metric and the feature now share the words "burn rate"; inside the tab the metric line is always `Burn rate` with its unit (`0.6%/h`), and the feature name appears only in titles, so the two never read as the same thing. Persisted open tabs keep working: the id `quota` is unchanged.
- **Surfaces.** Analytics tab: a *Burn rate* card (burn rate, quota per run, attempts, low-confidence flag, (i) formula). Burn rate limiting tab: per project, the burn rate of each playbook with the (i) formula and the reset controls; a Reservations row reads `weekly: ~0.3% (about 25m at 0.7%/h)` when the run's need is every remaining step's duration × burn rate; the throttle caption now says the typical need comes from durations × burn rate, else the cost of a step. Hold reasons (`rateHold.reason`, "(from history)") are unchanged: the estimate may mix both sources, and the one-notice-per-episode logic is untouched. The run bar, run detail and the Runs view priority popover show no estimate and are unchanged.
- **Hard reset.** RPC `quota.reset_burn_rate { playbook, step?, all? }` (also the agent tool `reset_burn_rate`, see "Agent tool and reset all" below), idempotent, returns what was erased `{ entries, steps, ms }`.
  - Playbook reset: deletes every learned cost row `<playbook>|<provider>\0<window>` (points, steps, agent time) and every step duration of the playbook. `entries` = rows, `steps` = finished attempts behind them, `ms` = agent time.
  - Step reset: clears only that step's learned duration (`steps` = its samples, `ms` = their summed duration, `entries` = 0). Points are learned per playbook and per window, not per step, so the points part cannot be reset per step: the step falls back to the average cost of a step until its duration is measured again. The tab says so ("clears this step's duration estimate").
  - Live effects: the in-memory history is updated and saved at once; measures in flight of a playbook reset are dropped; the reservations of the playbook's runs lose their need (no history, no need, not paced); the pace plan and the held runs are looked at again, so a held run of the playbook is released at once.
  - Record: `rate-history.json` keeps the time of the last reset per playbook and per step (`@resets`, additive; older files load unchanged), shown as `reset <date>`; the event `quota.burn_rate_reset { playbook, step|null, erased, by }` is emitted (not tied to a run) and logged.
  - UI: a *Reset* per playbook and per step (under "Steps") with an inline confirmation ("Erase the learned burn rate of X? It runs without limits until measured again."). Neutral and accent colours, never red.

## Consequences

- A reset playbook runs unpaced until it has measured again (it is flagged low confidence while it re-learns); a reset taken in error costs only the relearning.
- Only the label of the tab changes, so nothing persisted breaks. Old ADRs keep the old name except where they define the tab, whose status lines point here.

## Agent tool and reset all

Added the same day. The first release was panel only, but an agent (a coordinator) has no way to call a plugin RPC, and had to edit `rate-history.json` by hand with the plugin disabled. So:

- **Tool.** `reset_burn_rate { playbook?, step?, all? }`, with the same semantics and live effects as the RPC (hard reset, step reset, idempotent, runs lose their need, held runs released at once, `@resets`, event `quota.burn_rate_reset`). Exactly one of `playbook` (+ optional `step`) or `all: true` must be given; anything else is a validation error. The tool description says it deletes learned data and that runs are unpaced until measured again.
- **Who.** Like `set_run_priority` and `set_run_quota_exempt`: in `MANAGER_TOOL_NAMES` and in the run tools the Sidekick gets, never a step agent's tools. The event and the log carry `by` (`agent <id>` for the tool, the tab's name for the panel).
- **All.** `all: true` (tool, and RPC `quota.reset_burn_rate { all: true }`) resets every playbook that has a learned row or step duration, one event per playbook; the tool result lists the counts erased per playbook (`entries`, `steps`, `ms`) with their total, the RPC returns the total.
- **UI.** A *Reset all* link at the top of the per-playbook Burn rate section, with the same inline two-step confirmation and the caption "Erases the learned burn rate of every playbook. They run without limits until measured again."

Consequence: an agent can now erase learned data, which a mistaken call costs only the relearning of; every call is visible in the event stream.
