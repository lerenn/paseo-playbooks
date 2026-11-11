# Sidekick column: plugin messages shown as closed special lines

## Status

Accepted

## Context

The plugin wakes the Sidekick with "[playbooks]" messages (event batches, subagent notices, gate sweeps, hand-off requests). They rendered as the human's own bubbles, long and easily mistaken for something the human wrote.

## Decision

- A user message that starts with "[playbooks]" renders as a dashed card with the plugin icon: one closed line (its first line, plus the event kinds it lists), opened on click to the full text (`pluginMessage` in `client/sidekick/instructions.ts`).
- The messages the plugin sends without the prefix (subagent finish notices, gate sweeps, hand-off requests) now carry it.

## Consequences

Extends the "Instructions sent to the Sidekick" treatment of the column display ADR. Messages sent before this change without the prefix still show as bubbles. Display only: nothing the agent receives changes except the prefix.
