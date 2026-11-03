---
name: paseo-playbooks
description: Write or change paseo-playbooks playbooks and roles (.paseo/plugins/playbooks/). Use when asked to create, edit, review or debug a playbook, a role, playbook inputs/outputs, gates or loops for the Paseo Playbooks plugin.
---

# Writing paseo-playbooks playbooks

The paseo-playbooks Paseo plugin lets a **Playbook Manager** agent run a playbook: each
step runs as a subagent, the plugin enforces the graph, and humans approve gates in the
Playbooks panel. You write the playbooks; the plugin validates them.

**Always finish by calling the `validate_playbooks` tool and fixing every error it reports.**
It uses the same checks as the Playbooks panel.

## Layout

Everything lives in the repository, under `.paseo/plugins/playbooks/` or the shorter
`.paseo/playbooks/` (both are loaded; use one):

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

- Every top-level `*.yaml` or `*.yml` file is a playbook. Shared settings live in folders, so no file
  name is reserved.
- Each of the two folders is self-contained: a playbook uses the `roles/` and
  `defaults/main.yaml` of its own folder. The same playbook id in both folders is an error.
- Ids (playbooks, roles, steps, inputs, outputs) use lowercase letters, digits, `-` and `_`,
  and start with a letter.
- A playbook refers to a role by its directory name. Roles are shared by playbooks.

## defaults/main.yaml

```yaml
agent:                 # defaults for every step
  provider: claude
  model: claude-opus-5-5
  mode: bypassPermissions
manager:               # settings of the manager agent when Start creates a new one
  mode: default
timeout: 1h            # default step timeout (optional)
```

Agent settings (`provider`, `model`, `mode`, `thinking`) merge field by field. Precedence:
step > role > playbook > `defaults/main.yaml` > the manager's own provider and model.
Any mode is allowed; an unset mode uses the provider's default.

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
description: Investigate, implement, open a PR and babysit it until it is green.
agent: { model: claude-opus-5-5 }          # optional playbook-wide settings
concurrency: 1                             # optional: max active runs (or held blocks) in the project

inputs:                                    # the Start form; the manager fills them from chat
  request: { type: string, required: true, description: What to change }
  base_branch: { type: string, default: main }

outputs:                                   # the run's result
  pr_url: { type: string }                 # no value: auto-matched from a step output named pr_url
  pr_number: { type: number, value: "{{ steps.implement.outputs.pr_number }}" }

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
```

### Steps

| Field | Meaning |
| --- | --- |
| `id` | Unique; `end`, `fail` and `outputs` are reserved. |
| `needs` | Steps that must complete first. No `needs` = starts with the run. Steps ready together run in parallel. File order does not matter. |
| `role` / `gate` / `playbook` | Exactly one: an agent step, a human gate with its message, or a sub-playbook (see below). |
| `inputs` | List of names (auto-matched) or map of name → source (`"{{ playbook.inputs.x }}"`, `"{{ steps.<id>.outputs.y }}"`) or `~`. |
| `outputs` | Typed values the step must return with any outcome except `failure` (a failure report skips output validation). All are required then. |
| `prompt` | Template; may use only `{{ inputs.<name> }}`, `{{ run.id }}`, `{{ attempt }}`. |
| `outcomes` | Default `[success, failure]`. The first one completes the step by default. |
| `on` | Per outcome: `complete`, `end`, `fail`, `{ goto: <earlier step>, max_loops: N }`, or `{ ask: "<text>", goto: <step>, max_loops: N }` (agent steps; see Loops). Every outcome other than the first and `failure` needs an entry. |
| `retries` | Extra attempts after `failure`. |
| `timeout` | `30m`, `2h`… Expiry counts as a failure. |
| `agent` | Step-level agent settings. |
| `choices` | Gates only: the buttons, in order. Each key is an outcome, with `label`, `comment: none \| optional \| required` and `color: primary \| neutral \| success \| warning \| danger` (theme colours; default primary for the first, neutral for the others). Without `choices`, the default Reject is `danger`. |

A gate's outcomes are the keys of its `choices` (default: `approved` with label Approve, and
`rejected` with label Reject and an optional comment). The first choice completes the gate
by default; any other choice fails the run unless `on` sends it elsewhere. The panel shows
one full-width button per choice with where it leads (→ End, → End Release inside a block,
→ Implement, → Fail run). A choice with `comment: optional` or `required` opens a text box with Send; the comment goes
to the manager and, on a `goto`, to the target step as feedback.

### Sub-playbooks

A step with `playbook: <id>` runs another playbook of the same folder in place, like a
building block:

```yaml
steps:
  - id: pr
    playbook: pr                 # its inputs match by name, or map them in `inputs`
  - id: approve
    needs: [pr]
    gate: Release it?
    on:
      rejected: { goto: pr }     # restarts the whole block, with the comment as feedback
  - id: release
    needs: [approve]
    playbook: release            # gets pr_url from the pr block's outputs
```

- The loader expands the block: its steps become `pr.investigate`, `pr.implement`, … in
  the same run, with the same manager. Its first steps take the block's `needs`; steps that
  need the block wait for its last steps.
- The block's inputs are the sub-playbook's inputs (auto-matched by name, or mapped in
  `inputs`; unmatched ones use their default). Its outputs are the sub-playbook's outputs,
  so later steps can use them by name or as `{{ steps.pr.outputs.pr_url }}`.
- Loops inside the sub-playbook stay inside. A `goto` to the block restarts it from its
  first step (the sub-playbook must have exactly one).
- `end` inside the sub-playbook ends the block, not the run: the step completes, the
  block's other unfinished steps become `skipped` (running ones are interrupted), and the
  steps that need the block go on. In nested blocks it ends only the innermost one. The
  block's outputs are what its completed steps produced. `fail` still fails the whole run.
  A `goto` to the block runs it again.
- `prompt`, `outputs`, `outcomes`, `timeout`, `agent`, `choices` and `on` do not apply to
  a playbook step. A playbook that includes itself (directly or not) is an error.
- The sub-playbook's manager settings are ignored; its gates stay gates of the run.
- The sub-playbook's `concurrency` applies to the block. Its slots are shared by every run
  in the project (also top-level runs of that playbook). A run takes a slot when the block's
  first steps become ready and keeps it until all the block's steps complete (also while a
  gate inside waits; skipped steps count as done), or the run ends. Until a slot is free those steps are `queued`
  instead of `ready`: do not start them; the plugin wakes you when they are ready. Use it
  to serialise a part of a playbook (for example `release`) across runs that do the rest in
  parallel. A `goto` that restarts the block's first steps gives the slot back and queues again.

### After-tasks

`after:` lists tasks that run once the run has ended, whatever its outcome, such as a retro.
Each one is an agent step (`role` + `prompt`), a gate, or a sub-playbook (`playbook: <id>`):

```yaml
after:
  - id: retro
    playbook: retro      # its run_id input matches {{ run.id }} by name
  - id: notify
    role: reviewer
    trigger: manual      # a Start button on the finished run (default: auto)
    inputs:
      status: "{{ run.status }}"
    prompt: "Post a summary of run {{ run.id }} ({{ inputs.status }})."
```

- They belong to the same run and manager and show below End in the panel. They never
  change the run's status (fixed when the main graph ends).
- `auto` tasks start when the run completes or fails, not when it is canceled. `manual`
  tasks start from the panel on a finished run, in any end state, once.
- No `needs`. Inside an after-task, `end` completes the task, and `fail`, exhausted retries
  or a rejected gate fail the task only (in a sub-playbook, a nested block's `end` still
  ends only that block).
- Inputs may also use `{{ run.id }}`, `{{ run.status }}`, `{{ run.failure }}`,
  `{{ run.outputs.<name> }}` (the run's outputs, partial if it failed) and any main step's
  outputs. By name, an input matches the playbook's outputs, then `run_id`, `run_status`,
  `run_failure`, then the playbook's inputs. Prompts may use `run.status` and `run.failure`.
- A sub-playbook's own `after:` is ignored when it is nested; a sub-playbook used as an
  after-task has its `concurrency` ignored.
- Canceling the run while after-tasks run cancels them; the run's status stays.
- The "may both edit files" rule applies between after-tasks, not between an after-task and
  a main step.

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

To let an agent step ask a human a question, give it an outcome that routes to `ask`:

```yaml
- id: investigate
  role: investigator
  outcomes: [success, needs_input]   # the agent reports needs_input with its question as summary
  on:
    needs_input: { ask: "The investigation needs your input.", max_loops: 3 }
```

`complete_step` with that outcome opens a gate (the step shows as waiting); the human types
the answer in the panel (required). The step then runs again, with the answer as feedback.
`goto` (default: the step itself) may name an earlier step instead. The report needs no
outputs. `ask` is not available on gate steps.

### Rules the validator enforces

- no cycles in `needs`; no unknown steps, roles, inputs or outputs
- two steps that can run at the same time (neither needs the other) must not both be able
  to edit files: make one role `readonly: true` or order them with `needs`
- prompts use only `inputs`, `run.id` and `attempt` (after-tasks also `run.status` and
  `run.failure`); inputs only reference ancestors (after-tasks also main steps and `run.*`)
- after-tasks have no `needs`, and only after-tasks have `trigger`
- no `next` key: chaining was removed; to run a playbook after another, write a parent
  playbook that includes both as sub-playbook steps

## YAML pitfall

Inside a flow mapping (`{ ... }`), a comma ends the value. Quote any text that contains a
comma, or use block style:

```yaml
outputs:
  changes: { type: string, description: "What you changed, per file" }
```

## Checklist

1. Write roles first (`role.yaml` + a clear `instructions.md` that names its outputs).
2. Draw the graph with `needs`; keep parallel steps readonly.
3. Declare typed outputs on producers and inputs on consumers; prefer matching names.
4. Add gates where a human must decide, and `goto` loops with `max_loops`.
5. Run `validate_playbooks`; fix everything; commit the files (Start in a new workspace
   branches a worktree from the current commit; Start and Start on a new agent run in this checkout).
