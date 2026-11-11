# Sidekick subagents: permission mode

Status: Accepted

Extends `2026-11-11-sidekick-runtime.md` (the `sidekick.subagents` block).

## Context

`sidekick.subagents` set the provider and model of the subagents a Sidekick creates, not their permission
mode. The Sidekick itself calls Paseo's `create_agent`; the plugin does not create them, it only names the
provider and model in the Sidekick's prompt.

## Decision

- `sidekick.subagents.mode` is optional: a Paseo agent mode id (`default`, `acceptEdits`, `plan`, `auto`,
  `bypassPermissions`, or a provider's own). When set, the prompt tells the Sidekick to pass
  `settings: { modeId: "<mode>" }` to every `create_agent`.
- When unset the plugin sends no mode: nothing is inherited from the Sidekick's own `sidekick.mode`; the
  provider's default mode in Paseo applies.
- A value that is not a string shaped like a mode id is ignored: the Sidekick starts without it and the
  loader reports a warning (logged when the Sidekick opens). Whether the provider knows the id is left to Paseo.

## Consequences

- The mode is applied by the Sidekick following its prompt, not enforced by the plugin.
- Unknown-but-well-formed ids are not caught by the plugin.
