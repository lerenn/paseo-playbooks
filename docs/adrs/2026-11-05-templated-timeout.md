# Templated step timeout

Status: Accepted

## Context

A sub-playbook used several times may need a different timeout each time: the anyshift
`env_release` (ANY-2906) releases dev, stg and prd, which take up to 5h, 4h and 6h. `timeout`
was a fixed duration, so the one step could not carry all three.

## Decision

- A step's `timeout` may be a template of the step's own inputs, as its prompt is:
  `timeout: "{{ inputs.release_timeout }}"`. Other references, or an input the step does not
  declare, fail validation.
- It renders when each attempt starts; the attempt stores the result (`timeoutMs`), which the
  timeout timer and the silence reminder use. Attempts without one use the step's timeout.
- An empty value falls back to the default timeout (`defaults/main.yaml`), or none. A value
  that is not a duration refuses the start; when it only depends on the run's inputs (a
  parent's literal, a playbook input) the run's start is refused instead.

## Consequences

- Additive: fixed timeouts are unchanged. A playbook step still takes no `timeout`; pass the
  value as an input of the sub-playbook.
