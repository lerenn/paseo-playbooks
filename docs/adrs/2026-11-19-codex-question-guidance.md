# Codex human question guidance

## Status

Accepted

## Context

Codex managers can submit questions with no options, leaving the human to invent an answer
in a free-text field. The plugin mirrors provider-native questions as manager question gates.
The native question tool and its validation belong to Paseo's provider, not this plugin;
rewriting its options after submission would change what the manager asked.

## Decision

Append a Codex-only system instruction when the plugin creates a manager, step agent or
role gate decider, after selecting the actual provider (including fallback and recovery).
Ask for 2–3 mutually exclusive substantive alternatives for decision questions, the advised
choice first with `(Recommended)` when evidence supports it, and a real free-text route.
Permit genuinely open-ended questions without fabricated choices and preserve exactly the
choices of an existing playbook gate. Keep Claude prompts and the question mirroring/answer
contract unchanged. Do not retrofit existing agents or restart runs. This adds prompting
guidance, not enforcement: the plugin has no supported hook to replace Codex's native tool
schema or validate its questions before the provider accepts them. It also cannot require a
provider/model to follow the guidance.

## Consequences

New Codex agents receive consistent guidance across creation paths. Native provider limits
and model compliance still apply; empty/poor options cannot be blocked at creation by this
plugin. Submitted labels and descriptions pass through to the panel, and Other remains
available for answerable single-choice questions. No YAML or run-state migration is required.
