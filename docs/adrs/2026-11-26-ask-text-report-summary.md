# An ask text may show the step's own question

## Status

Accepted.

## Context

An `ask` transition's text is fixed when the playbook is written, so a step that reports
`needs_input` opens a gate titled with a generic sentence ("A decision is needed; see the step
report"). `list_gates`, the panel and any board built on the gate's `summary` then hide the actual
question; the human has to open the step report to learn what is asked. Only
`{{ playbook.inputs.* }}` and `{{ steps.<id>.outputs.* }}` could be read, and outputs are not
required for `needs_input`.

## Decision

An `ask` text may read `{{ report.summary }}`, the same name ask choice `outputs` already read. It
renders the first non-blank line of the summary the step completed with (the `complete_step`
summary, else the agent's report summary or final message), trimmed and cut to 300 characters
with "…" (cut on code points). An empty or missing summary renders as "(none)". The value is
substituted once, so any template text in the summary stays literal. It is accepted in after-tasks too (it reads no run context), and
refused in a gate step's `question`, which has no report.

## Consequences

- No change to run state, the gate shape or the tools: the rendered text lands in the gate's
  `summary` (and the start of its `message`) as before, and the full report stays in `details`.
- Playbooks that want the question in the title write `ask: "{{ report.summary }}"`; agents then
  need to put the question on the first line of their summary.
- The gate title in the panel is still the first sentence of `summary`; the rest of that line goes
  to the details, as for any gate.
