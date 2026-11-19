# Codex human question guidance

## Status

Accepted

## Context

Codex managers can submit a single generic “Answer” option, leaving the human to invent
an answer in Other. The plugin mirrors provider-native questions as manager question gates.
The native question tool and its validation belong to Paseo's provider, not this plugin;
rewriting its options after submission would change what the manager asked.

## Decision

Append a Codex-only system instruction when the plugin creates a manager, step agent or
role gate decider, after selecting the actual provider (including fallback and recovery).
Ask for 2–4 substantive alternatives within native tool limits, the advised choice first
with `(Recommended)` and a rationale, and the native free-text path. Permit genuine
free-form questions and preserve exactly the choices of an existing playbook gate.
Keep Claude prompts and the question mirroring/answer contract unchanged. Do not retrofit
existing agents or restart runs. This adds prompting guidance, not an enforcement hook or
a custom question tool.

## Consequences

New Codex agents receive consistent guidance across creation paths. Native provider limits
and model compliance still apply; the plugin cannot guarantee semantic choice quality or
force the provider's free-text UI. Submitted labels and descriptions still pass through to
the panel, and Other remains available. No YAML or run-state migration is required.
