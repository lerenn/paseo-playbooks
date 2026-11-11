# Sidekick subagents inherit the Sidekick's mode

Status: Accepted

Refines `2026-11-11-sidekick-subagents-mode.md`, whose default of "no mode" it replaces.

## Context

Subagents created without a mode got the provider's default in Paseo, which for Claude only allows Read, Glob
and Grep without asking. Users reported Sidekick subagents stuck with those tools while the Sidekick itself ran
in `bypassPermissions`.

## Decision

- When `sidekick.subagents.mode` is unset, the subagents' mode is the Sidekick's own `sidekick.mode`.
- An explicit `sidekick.subagents.mode` still wins.
- When neither is set the plugin sends no mode, as before.
- The rest of the earlier ADR (validation, prompt-based application) is unchanged, so it stays Accepted.

## Consequences

- A Sidekick in `bypassPermissions` now creates `bypassPermissions` subagents unless told otherwise; set
  `subagents.mode` to restrict them.
- Projects that set `sidekick.mode` and relied on subagents keeping the provider default see a change.
