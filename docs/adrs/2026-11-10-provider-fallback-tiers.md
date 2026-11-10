# Provider fallback: a tier may list several providers

Status: Accepted

Extends `2026-11-09-model-tiers.md`, whose tiers stay valid.

## Context

When a provider runs out of tokens (quota, rate or usage limit, no credits), the step agent
fails and the run stalls until a human or the manager intervenes. Repositories that have several
providers want the step to move on by itself.

## Decision

- In `defaults/main.yaml` a tier is a block (as before) or an ordered list of targets, each with
  `provider`, `model`, `mode`, `thinking` (strict keys; an empty list is an error). The first
  entry is the primary, the rest are fallbacks. There is no `fallback` key in the YAML. A
  one-entry list behaves as a plain block.
- A multi-entry tier cannot be combined with inline `provider`, `model`, `mode` or `thinking` on
  the same `agent` block: a load error says to define another tier. A layer that sets its own
  `provider` or `model` starts its own chain, so a fallback is never inherited into it.
- Loaded agent settings carry `fallback: [targets]`. A fallback target takes `provider` (default:
  the default provider), `model`, `mode` and `thinking` from its own entry only; it inherits
  nothing from the manager or lower layers.
- Run state: `run.exhausted` (`{ target, at }` entries: a `provider/model` and the ISO time it was marked, default `[]`; a bare string from an older run file loads with `at` set to the load time) and, per attempt, `target`
  (the `provider/model` its agent runs on) and `prompt` (what it was started with), both default
  `""`; older run files load.
- Detection: when a step agent's turn ends `failed` and its error entries (else its last assistant
  text) match the quota patterns of `server/quota.ts`, the plugin records the attempt's target in
  `run.exhausted` (a fresh `at`, replacing an older entry) and restarts the same attempt on the first target not exhausted: a new agent
  with the same prompt replaces `attempt.agentId`, the old agent is archived, and `retries` is not
  used. It logs a `provider_exhausted` run-log line and notifies the manager. Later agents of the
  run (steps, gate deciders) pick the first target that is not exhausted. An entry counts as exhausted only while less than `providers.exhausted_for` has passed since `at`; after that the target is tried again, and if it fails again it fails over again by the same path. If every target is exhausted, or the
  new agent cannot start, the failure goes to the manager as before. Other failures are unchanged.
- New block in `defaults/main.yaml`: `providers: { exhausted_for: 1h }` (a duration, parsed like `timeout`; default `1h`; strict block, a bad duration is a load error). Loaded as `playbook.exhaustedForMs`. The manager notice says when the target is tried again.
- The manager may use a multi-entry tier, but only the first non-exhausted entry is used, when a
  manager is created. A running manager never switches provider.
- No UI change: the run log and the manager notice are the only visibility.

## Consequences

- Error texts differ by provider and are matched by pattern; an unrecognized message is treated
  as an ordinary failure. The wordings behind the patterns (Claude Code "You've hit your session/weekly limit", Codex "You've hit your usage limit", API `rate_limit_error`, `insufficient_quota`) come from third-party reports, not official docs, and can change. The patterns live in one list in `server/quota.ts`. Note that an API `rate_limit_error` can be a transient throttle rather than a cap; it is treated as exhausted too.
- An exhausted target is retried after `exhausted_for`, since limits reset. A very short value re-probes a failing provider on every later agent, at the cost of one failed turn each time.
- Fallback targets must name their provider and model explicitly to be useful.
