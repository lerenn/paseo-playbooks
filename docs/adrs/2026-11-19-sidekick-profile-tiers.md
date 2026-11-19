# Sidekick profiles and tier fallback

## Status
Accepted

## Context
Sidekick settings lived outside profiles and duplicated the provider choices already expressed by tiers. A provider quota could leave the coordinator unavailable despite an available fallback.

## Decision
Search active profiles, sorted by id, for `sidekick/` before the existing top-level locations. The first wins; report competing folders as warnings. Resolve `sidekick: { tier }` and `sidekick: { subagents: { tier } }` against the containing repository's `defaults/main.yaml`, with the same restrictions on multi-entry tier overrides as role agents. Profile `agent_rules` apply to the Sidekick and its subagent briefs.

For the Sidekick, try tier targets in order, then `providers.fallback`, skipping exhausted targets and targets blocked by the configured usage threshold. On a quota ending, replace the agent with the next available target using its saved ledger, archiving the old agent first. Exhaustion lasts `providers.exhausted_for` in memory and is shared across Sidekicks until reload. If every target is exhausted, leave the failed agent visible; do not loop or add background retries. Starts, explicit restarts and compaction replacements use the same selection.

Subagents remain created by the Sidekick: its prompt supplies the selected target, alternatives and instructions to continue saved work after quota failure. Their fallback is prompt-enforced, not automatic runtime replacement.

## Consequences
Existing top-level Sidekick files still work without tiers. Profiles can share provider policy with their coordinator. A fallback replacement retains the last saved ledger, not the full conversation; providers, modes and models must exist on the local host. Step waiting/retry policy does not become a Sidekick retry scheduler.
