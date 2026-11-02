---
name: paseo-playbooks
description: Write or change paseo-playbooks playbooks and roles (.paseo/plugins/playbooks/). Use when asked to create, edit, review or debug a playbook, a role, playbook inputs/outputs, gates or loops for the Paseo Playbooks plugin.
---

# Writing paseo-playbooks playbooks

The paseo-playbooks Paseo plugin lets a **Playbook Manager** agent run a playbook: each
step runs as a subagent, the plugin enforces the graph, and humans approve gates in the
Playbooks panel. You write the playbooks; the plugin validates them.

**Always finish by calling the `validate_playbooks` tool and fixing every error it reports.**
It uses the same checks as the Playbooks panel, including the daemon's mode cap.

## Layout

Everything lives in the repository, under `.paseo/plugins/playbooks/`:

```text
.paseo/plugins/playbooks/
├── defaults/
│   └── main.yaml              # optional: repo-wide agent defaults
├── pr.yaml                    # a playbook; its id is the file name ("pr")
├── release.yaml
└── roles/
    └── reviewer/
        ├── role.yaml          # title, readonly, agent
        └── instructions.md    # the role's system prompt (required, non-empty)
```

- Every top-level `*.yaml` file is a playbook. Shared settings live in folders, so no file
  name is reserved.
- Ids (playbooks, roles, steps, inputs, outputs) use lowercase letters, digits, `-` and `_`.
- A playbook refers to a role by its directory name. Roles are shared by playbooks.

## defaults/main.yaml

```yaml
agent:                 # defaults for every step
  provider: claude
  model: claude-opus-5-5
  mode: bypassPermissions
manager:               # the manager agent that the panel's Start creates
  mode: default
timeout: 1h            # default step timeout (optional)
```

Agent settings (`provider`, `model`, `mode`, `thinking`) merge field by field. Precedence:
step > role > playbook > `defaults/main.yaml` > the manager's own provider and model.
The resolved `mode` must be allowed by the daemon's cap (Settings → Plugins →
paseo-playbooks); an unset mode is always allowed.

## roles/<id>/role.yaml and instructions.md

```yaml
title: Reviewer
readonly: true         # must not edit files; enforced by a git check after each step
agent: { thinking: high }
```

`instructions.md` is the role's system prompt: what the role does and returns. The plugin
appends the step protocol (allowed outcomes, required outputs, `report_step_result`).

A `readonly` role may still run commands (tests, linters) but must leave tracked files,
the index and HEAD unchanged; build output in ignored files is fine.

## A playbook

```yaml
title: Pull request
description: Investigate, implement, open a PR and babysit it to a human gate.
agent: { model: claude-opus-5-5 }          # optional playbook-wide settings
concurrency: 1                             # optional: max active runs in the project

inputs:                                    # the Start form; the manager fills them from chat
  request: { type: string, required: true, description: What to change }
  base_branch: { type: string, default: main }

outputs:                                   # the run's result
  pr_url: { type: string }                 # no value: auto-matched from a step output named pr_url
  pr_number: { type: number, value: "{{ steps.implement.outputs.pr_number }}" }

next:                                      # optional chaining; the manager decides
  - playbook: release

steps:
  - id: investigate
    role: investigator
    inputs: [request]                      # list form: every name auto-matched
    outputs:
      plan: { type: string }
    prompt: "Request: {{ inputs.request }}"

  - id: implement
    role: implementer
    needs: [investigate]
    inputs: [request, plan, base_branch]
    outputs:
      pr_url: { type: string }
      pr_number: { type: number }
      branch: { type: string }
    retries: 1
    timeout: 1h
    prompt: |
      Request: {{ inputs.request }}
      Plan: {{ inputs.plan }}

  - id: review
    role: reviewer
    needs: [implement]
    inputs: [pr_url]
    outputs: { findings: { type: string } }
    prompt: "Review {{ inputs.pr_url }}"

  - id: babysit
    role: babysitter
    needs: [review]
    inputs:                                # map form: explicit source, or ~ for auto
      pr_url: ~
      review: "{{ steps.review.outputs.findings }}"
    outcomes: [ready, changes_requested]
    on:
      changes_requested: { goto: implement, max_loops: 3 }

  - id: pr_approval
    needs: [babysit]
    gate: The PR is ready. Approve to finish, or reject with a comment to send it back.
    on:
      rejected: { goto: implement }
```

### Steps

| Field | Meaning |
| --- | --- |
| `id` | Unique; `end` and `fail` are reserved. |
| `needs` | Steps that must complete first. No `needs` = starts with the run. Steps ready together run in parallel. File order does not matter. |
| `role` / `gate` | Exactly one: an agent step, or a human gate with its message. |
| `inputs` | List of names (auto-matched) or map of name → source (`"{{ playbook.inputs.x }}"`, `"{{ steps.<id>.outputs.y }}"`) or `~`. |
| `outputs` | Typed values the step must return. All are required. |
| `prompt` | Template; may use only `{{ inputs.<name> }}`, `{{ run.id }}`, `{{ attempt }}`. |
| `outcomes` | Default `[success, failure]`. The first one completes the step by default. |
| `on` | Per outcome: `complete`, `end`, `fail`, or `{ goto: <earlier step>, max_loops: N }`. Every outcome other than the first and `failure` needs an entry. |
| `retries` | Extra attempts after `failure`. |
| `timeout` | `30m`, `2h`… Expiry counts as a failure. |
| `agent` | Step-level agent settings. |

Gates have outcomes `approved` (completes) and `rejected` (fails the run unless `on.rejected`).

### Variables

Types: `string`, `number`, `boolean`, `enum` (with `values: [...]`); each may have
`required`, `default`, `description`.

An input without a source takes the same-named output of an **ancestor** step (a step it
needs, directly or not), else the playbook input with that name. If several ancestors
output that name, validation fails: map it explicitly. Nothing is chosen silently.

### Loops

`goto` must point to an earlier step that this one needs (or itself). It re-runs the
target and every step after it. The step or gate that looped hands its summary or comment
to the target as "Feedback to address". Reaching `max_loops` opens a "loop limit" gate.

### Rules the validator enforces

- no cycles in `needs`; no unknown steps, roles, inputs or outputs
- two steps that can run at the same time (neither needs the other) must not both be able
  to edit files: make one role `readonly: true` or order them with `needs`
- prompts use only `inputs`, `run.id` and `attempt`; inputs only reference ancestors
- modes within the daemon cap
- `next` targets exist and their required inputs are covered

## Checklist

1. Write roles first (`role.yaml` + a clear `instructions.md` that names its outputs).
2. Draw the graph with `needs`; keep parallel steps readonly.
3. Declare typed outputs on producers and inputs on consumers; prefer matching names.
4. Add gates where a human must decide, and `goto` loops with `max_loops`.
5. Run `validate_playbooks`; fix everything; commit the files (the panel's Start branches
   a worktree from the current commit).
