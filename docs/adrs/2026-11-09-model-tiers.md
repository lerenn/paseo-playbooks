# Model tiers: named agent settings in `defaults/main.yaml`

Status: Accepted

## Context

Every role, step and playbook that wants a cheaper or stronger model repeats `provider` and
`model`. Moving a repository from Claude to Codex means editing each of them.

## Decision

- `defaults/main.yaml` gains `tiers`, a map of names (lowercase letters, digits, `-`, `_`) to
  blocks of `provider`, `model`, `mode` and `thinking`, all optional; other keys are errors:
  `tiers: { cheap: { provider: claude, model: claude-haiku-5-5 }, advisor: { …, thinking: high } }`.
- Every `agent` block takes `tier: <name>`: the defaults' `agent` and `manager`, a playbook's
  `agent`, a role's `role.yaml` `agent`, a step's `role: { agent }`, and a new
  `decider: { by: role, role, agent }` for the role deciding a gate (an error with another `by`).
- A block resolves on its own: the tier's fields, then the block's own fields over them
  (explicit beats the tier). The layers then merge as before: step > role > playbook >
  defaults > the manager's own. A field a layer leaves unset (a tier without `thinking`) still
  comes from a lower layer.
- An unknown tier is a load error naming the tiers defined. Tiers are per playbook folder, as
  `defaults/main.yaml` is. A tier cannot reference another tier.
- No run-state change: a loaded step still carries resolved `provider`, `model`, `mode`,
  `thinking`.

## Consequences

- Switching provider is one edit of the tiers; `tier` is optional and playbooks without it
  load as before.
- A tier does not clear a lower layer's field, so a Codex tier over a defaults `thinking`
  inherits it; give every tier the fields that matter.
