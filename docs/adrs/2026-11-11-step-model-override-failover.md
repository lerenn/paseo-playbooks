# Step model override and wider provider failover

Status: Accepted

Extends `2026-11-10-provider-fallback-tiers.md` and `2026-11-10-wait-for-tokens.md`, whose chains,
`exhausted_for` and `on_exhausted` stay valid.

## Context

A step whose provider hit its limit stalled for days (run_c606f3): Claude Code ended the turn
normally with "You've hit your weekly limit · resets Nov 16, 2pm (Europe/Paris)" as its last message,
so the fail-over, which only looked at failed turns, never ran. The role had a single model, so there
was nothing to fail over to anyway. The manager could not help: `start_step` only starts a ready
step, `nudge_step` only sends a message to the same agent, `restart_run` only reopens finished runs,
and Paseo cannot change a running agent's provider or model.

## Decision

- Detection: besides a failed turn whose error matches `server/quota.ts`, a turn that ends
  `completed` without a report also counts as out of tokens when its last assistant message is short
  (at most 400 characters, `QUOTA_MESSAGE_MAX`) and matches the same patterns. Longer texts are the
  agent's own words. Patterns added: `<period> limit` (weekly, session, Opus...), `limit … resets`,
  `HTTP/status 429`, "out of extra usage". Such a turn takes the existing fail-over path; no report
  reminder is sent. With no target left, the manager is told the provider is out and how to move the
  step.
- New key in the `providers` block of `defaults/main.yaml`: `fallback: [provider/model, ...]`
  (strings; a malformed entry is a load error). Loaded as `playbook.fallback` (default `[]`). It is
  appended to every step agent's chain after the tier's own entries, skipping duplicates. A fallback
  entry, like a manager's model, keeps the role's `mode` and `thinking` only on the same provider
  (they are provider-specific). Per-role chains stay multi-entry tiers; there is still no
  `fallback` key on an `agent` block.
- Manager override: `start_step`, `nudge_step` and `restart_run` take optional `model`
  (`provider/model`) and `thinking`. The model must be listed by `providers.listModels` (ids or
  aliases), and `thinking` must be one of its options; otherwise the call is refused with the list.
  - `start_step`: that attempt's agent runs on it instead of the chain.
  - `nudge_step`: an agent cannot switch model, so a new agent on that model replaces the current
    attempt's agent (same attempt, no retry used, full timeout and silence window), started with the
    attempt's prompt, a hand-over note naming the old agent, and the message. The old agent is
    archived. Refused once the attempt has a report. Run-log line `step_model_changed`.
  - `restart_run`: stored as `step.nextModel` (`{ target, thinking? } | null`, default null) and used
    by that step's next `start_step` unless it passes its own model; cleared on use.
  - A later out-of-tokens failure of an overridden attempt fails over along the role's chain as usual.
- Profiles: not accepted. The plugin API does not expose Paseo's agent profiles; the manager copies a
  profile's provider and model from `list_profiles` into `model`.
- Run state: `attempt.agents: [{ agentId, target, at, why }]` (default `[]`), `why` one of `chain`,
  `model`, `failover`, `resumed`. `get_run` shows each agent step's current `model` in the compact
  view, and `models` (per attempt, its agents) plus `nextModel` in the full view.

## Consequences

- A stalled step can be moved by the manager in one call, and a repository can give every role a
  last-resort model with one line.
- A short final message that quotes a limit notice is taken for one. The step then moves to the next
  target or the manager is told, which is cheap to undo with `nudge_step`.
- Nudging with a model loses the old agent's context: the new agent gets the step prompt again and
  must find the work done so far (the hand-over note says how).
