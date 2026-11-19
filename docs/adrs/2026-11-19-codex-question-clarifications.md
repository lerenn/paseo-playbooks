# Clarify Codex decision-question guidance

## Status

Accepted

## Context

The original Codex question guidance allowed 2–4 choices and did not explicitly cover ordinary clarification questions or empty decision option lists. Native question schemas and validation belong to the provider.

## Decision

Supersede `2026-11-19-codex-question-guidance.md`. Guide new Codex managers, step agents and gate deciders to offer 2–3 meaningful, mutually exclusive choices for decisions, within native tool limits. Recommend a choice only with supporting evidence, preserve the open-text route, and keep genuinely open-ended questions free-form. Existing playbook gates retain their declared choices.

This remains prompt guidance. The plugin cannot replace the provider's schema, reject questions before submission, or guarantee model compliance. Existing agents are not retrofitted.

## Consequences

Clarification and mirrored gate questions receive the same guidance. Submitted labels and descriptions remain intact, and Other remains available for answerable single-choice questions. Claude prompts and the question-answer contract are unchanged; no YAML or run-state migration is required.
