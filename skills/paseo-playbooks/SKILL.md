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
├── roles/
│   └── reviewer/
│       ├── role.yaml          # title, readonly, agent
│       └── instructions.md    # the role's system prompt (required, non-empty)
└── scripts/
    └── wait-pr-merged.sh      # optional: executables for script steps
```

- Every top-level `*.yaml` or `*.yml` file is a playbook. Shared settings live in folders, so no file
  name is reserved.
- Each of the two folders is self-contained: a playbook uses the `roles/` and
  `defaults/main.yaml` (and `scripts/`) of its own folder. The same playbook id in both folders is an error.
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
silence: 30m           # remind a step agent after this long without activity (default 30m; off to disable)
archive_agents: true   # archive step agents once the run no longer needs them (default true)
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
hidden: false                              # optional: true moves it to the panel's collapsed "Hidden playbooks" section (sub-playbook / after-task only)

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
| `title` | Full name, shown in the step's details and on its graph node. Default: the id, capitalised (`investigate` → Investigate). On a playbook step it names the block's frame. |
| `short_title` | Name in the Playbooks screen's step columns. Default: `title`. Not on playbook steps (their own steps are the columns). |
| `needs` | Steps that must complete first. No `needs` = starts with the run. Steps ready together run in parallel. File order does not matter. |
| `role` / `gate` / `playbook` / `script` | Exactly one: an agent step, a human gate with its message, a sub-playbook, or a script the plugin runs itself (see below). |
| `inputs` | List of names (auto-matched) or map of name → source (`"{{ playbook.inputs.x }}"`, `"{{ steps.<id>.outputs.y }}"`) or `~`. |
| `outputs` | Typed values the step must return with any outcome except `failure` (a failure report skips output validation). All are required then. |
| `prompt` | Template; may use only `{{ inputs.<name> }}`, `{{ run.id }}`, `{{ attempt }}`. |
| `outcomes` | Default `[success, failure]`. See "Outcomes" below. |
| `on` | Per outcome: `complete`, `end`, `{ end: <playbook outcome> }`, `fail`, `{ goto: <earlier step>, max_loops: N }`, or `{ ask: "<text>", goto: <step>, max_loops: N, choices: {...} }` (agent steps; a choice may `goto` a step or end the step with an `outcome` and `outputs`; see Loops). |
| `retries` | Extra attempts after `failure`. |
| `timeout` | `30m`, `2h`…, or a template of the step's inputs (`"{{ inputs.release_timeout }}"`), rendered when each attempt starts; an empty value falls back to the default timeout, a value that is not a duration fails the start (or the run's start, when it only depends on the run's inputs). Expiry counts as a failure. The agent is reminded shortly before. If its work turns out done, `nudge_step` it: its next report replaces the timeout failure. |
| `silence` | Agent steps: after this long without agent activity (default `30m`, or `off`), the plugin asks the agent once to report or say what it is waiting for, and tells the manager. |
| `archive_agents` | Agent steps: when the step completes, or its run or after-task ends, its agents are archived, and an attempt's agent is archived when the next attempt starts (default `true`). `false` keeps them, e.g. to debug. |
| `poll` | Script steps only: rerun the script this often (`30s`, `1m`) while it exits with 75. |
| `agent` | Step-level agent settings. |
| `choices` | Gates only: the buttons, in order. Each key is an outcome, with `label`, `comment: none \| optional \| required` and `color: primary \| neutral \| success \| warning \| danger` (theme colours; default primary for the first, neutral for the others). Without `choices`, the default Reject is `danger`. |

A gate's outcomes are the keys of its `choices` (default: `approved` with label Approve, and
`rejected` with label Reject and an optional comment). The panel shows
one full-width button per choice with where it leads (→ End, → End Release inside a block,
→ Implement, → Fail run). A choice with `comment: optional` or `required` opens a text box with Send; the comment goes
to the manager and, on a `goto`, to the target step as feedback.

### Outcomes

One rule for agent steps and gates:

- The first outcome (a gate's first choice) completes the step by default.
- `failure` (agent steps only) retries while `retries` remain, then fails the run.
- **Every other outcome needs an `on` entry**, or validation fails:
  ``step "x": outcome "abort" needs an `on` entry (complete, end, fail, goto or ask)``.
- Exception: a gate without `choices` keeps the default Approve / Reject, and `rejected`
  fails the run without an `on` entry. A gate that declares `choices` (even `approved` /
  `rejected`) must give every choice but the first an `on` entry.

`end` ends the playbook it is written in: the run at top level, the block when the
playbook is nested as a sub-playbook, the task inside an after-task. `{ end: <outcome> }`
does the same, and also says how the playbook ended, for its parent (one of the playbook's
`outcomes`; see Sub-playbooks). `fail` always fails the whole run (inside an after-task, the
task only).

### Script steps

A step with `script: <file>` runs an executable from the folder's `scripts/`, with no
agent and no manager: the plugin starts it as soon as it is ready and completes it from the
result. Use it for deterministic work, above all **waiting** (a PR merged, a deploy
finished, a lane clear), so that no agent spends turns polling:

```yaml
steps:
  - id: wait_dev_lane
    script: wait-dev-lane-clear.sh
    poll: 1m                    # check every minute while it says "not yet"
    timeout: 2h                 # then fail (retries apply)
    inputs: [services]
    outputs: { lane_head: {} }
  - id: dev_release
    needs: [wait_dev_lane]
    role: env_releaser
```

The script contract:

- **The file:** a plain name in `scripts/` (no path), executable (`chmod +x`). Its
  shebang picks the language: `#!/usr/bin/env bash`, `#!/usr/bin/env python3`… It runs in the
  run's worktree, with the daemon's environment.
- **Inputs** come as environment variables, never in a command line:
  `PLAYBOOK_INPUT_<NAME>` (upper case; `services` → `PLAYBOOK_INPUT_SERVICES`), plus
  `PLAYBOOK_RUN_ID`, `PLAYBOOK_STEP_ID`, `PLAYBOOK_ATTEMPT`, `PLAYBOOK_CHECK` (1, 2, … within
  the attempt), `PLAYBOOK_WORKSPACE` and, after a `goto`, `PLAYBOOK_FEEDBACK`.
- **Exit code:** `0` = done; `75` = not yet, run me again after `poll` (without `poll`, 75 is a
  failure); anything else = `failure`.
- **Result:** on success, the last line of stdout may be a JSON object
  `{"outcome": "...", "summary": "...", "outputs": {...}}`, each key optional. `outcome`
  defaults to the first outcome, so a script can branch (`outcomes: [merged, closed]` with
  `on.closed`). Outputs are checked against `outputs` like an agent's report; a wrong one fails
  the attempt. On failure, `summary` (or the last stderr line) says why.
- **Checks must be idempotent and short:** each check looks once and exits. The plugin does
  the waiting between checks, and it reruns the current check after a daemon restart.
  A script must not edit the checkout (the concurrency rule does not check scripts).
- `prompt` and `agent` do not apply; `inputs`, `outputs`, `outcomes`, `on`, `retries`,
  `timeout` and `needs` work as for agent steps. A failure with retries left runs again by
  itself; the manager is woken only with the final result. Without `timeout` (here or in
  `defaults/main.yaml`) a polling script waits forever.
- Pausing the run lets a running script keep checking; its result waits for the resume.
  Canceling the run, or a `goto` that resets the step, kills it.

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
- `end` ends the playbook it is written in, so inside a sub-playbook it ends the block, not the run: the step completes, the
  block's other unfinished steps become `skipped` (running ones are interrupted), and the
  steps that need the block go on. In nested blocks it ends only the innermost one. The
  block's outputs are what its completed steps produced. `fail` still fails the whole run.
  A `goto` to the block runs it again.
- A sub-playbook can tell its parent how it ended. It declares a top-level `outcomes` list
  (default `[success]`; the first is a normal finish: all steps done, or a plain `end`), and
  a step ends it with another one through `{ end: <outcome> }`. The playbook step in the
  parent maps each other outcome in its `on`, as for any step: `complete` (go on with the
  steps that need the block), `end` or `{ end: <outcome> }` (end the playbook the step is
  written in: the run, or the block around it, which passes the outcome up in turn), or
  `fail`. Every outcome but the first needs an `on` entry. Run alone, such a playbook just
  completes.

  ```yaml
  # env_release.yaml (hidden: true): one environment
  outcomes: [success, no_deploy]
  steps:
    - id: release
      role: env_releaser
      inputs: [env, release_timeout]
      outcomes: [success, no_deploy, failure]
      on: { no_deploy: { end: no_deploy } }   # nothing to deploy: end this block, say why
      timeout: "{{ inputs.release_timeout }}"
  # release.yaml
  steps:
    - id: dev
      playbook: env_release
      inputs: { env: dev, release_timeout: 5h }
      on: { no_deploy: end }                    # skip stg, the prd gate and prd
    - id: stg
      playbook: env_release
      needs: [dev]
      inputs: { env: stg, release_timeout: 4h }
      on: { no_deploy: end }
  ```
- `prompt`, `outputs`, `outcomes`, `timeout`, `silence`, `archive_agents`, `agent` and
  `choices` do not apply to a playbook step (its `on` takes only `complete`, `end` and `fail`, and not on an after-task). A playbook that includes itself (directly or not) is an error.
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
    playbook: retro
    inputs:
      run_id: "{{ run.id }}"   # run values are always mapped explicitly
  - id: notify
    role: reviewer
    trigger: manual      # a Start button on the finished run, or start_after_task (default: auto)
    inputs:
      status: "{{ run.status }}"
    prompt: "Post a summary of run {{ run.id }} ({{ inputs.status }})."
```

- They belong to the same run and manager and show below End in the panel. They never
  change the run's status (fixed when the main graph ends).
- `auto` tasks start when the run completes or fails, not when it is canceled. `manual`
  tasks start on a finished run, in any end state, once: from the panel, or with
  `start_after_task` (`runId`, `taskId`) when the human asks an agent in chat.
- No `needs`. Inside an after-task, `end` completes the task (it ends the playbook it is written in), and `fail`, exhausted retries
  or a rejected gate fail the task only (in a sub-playbook, a nested block's `end` still
  ends only that block).
- Inputs may also use `{{ run.id }}`, `{{ run.status }}`, `{{ run.failure }}`,
  `{{ run.outputs.<name> }}` (the run's outputs, partial if it failed) and any main step's
  outputs. By name, an input matches the playbook's outputs, then the playbook's inputs,
  as elsewhere. Run values never match by name: write `run_id: "{{ run.id }}"`. Prompts
  may use `run.status` and `run.failure`.
- A sub-playbook's own `after:` is ignored when it is nested; a sub-playbook used as an
  after-task has its `concurrency` ignored.
- Canceling the run while after-tasks run cancels them; the run's status stays.
- The "may both edit files" rule applies between after-tasks, not between an after-task and
  a main step.
- Step agents cannot call `get_run`. A retro step that reviews the whole run gets it from
  the manager: tell the manager (in the playbook `description`) to put `get_run` with
  `view: "full"` in the step's brief. The default `get_run` view is compact (per step: status,
  outcome, attempts, turn end and the first 300 characters of the summary), without reports
  or outputs.

### Variables

Types: `string`, `number`, `boolean`, `enum` (with `values: [...]`); each may have
`required`, `default`, `description`.

Two namespaces: in a step's `inputs:` map, sources are `{{ playbook.inputs.x }}` and
`{{ steps.<id>.outputs.y }}`; in a `prompt`, you only read the step's own inputs as
`{{ inputs.x }}`. To use a value in a prompt, declare it as an input first.

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
outputs (those it gives are kept). `ask` is not available on gate steps.

`choices` gives the ask gate several buttons, each going to its own step. Keys are the
choice ids; each takes `goto` (default: the ask's `goto`, else the step itself),
`max_loops` (default: the ask's), `label`, `color` and `comment` (default `required`):

```yaml
on:
  blocked:
    ask: "Local QA is blocked."
    max_loops: 3
    choices:
      answered: {}                      # re-run this step with the answer
      fix: { goto: fix, label: "Request a code change" }
      skip: { comment: none }
```

The target gets `The human answered "<id>": <comment>` as feedback. Without `choices` the gate
has the single `answered` button and the target gets the answer alone.

A choice with `outcome` instead ends the asking step with that outcome, as if the step had
reported it, without running it again: the outcome's `on` entry applies (`complete`, `end`,
`fail` or `goto`, not another `ask`). `outputs` sets the step's outputs, merged over the ones
of its last report (an `ask` report keeps the outputs it gives, none required). They are
templates over `{{ gate.comment }}` (empty: `(none)`), `{{ gate.choice }}`,
`{{ report.summary }}`, `{{ report.outputs.<output> }}` and `{{ inputs.<input> }}`. Once
merged they are checked like a report: a missing output refuses the decision.

```yaml
outcomes: [success, unverified, fail]
outputs: { report: {}, passed: { type: boolean }, accepted_unverified: {} }
on:
  fail: fail
  unverified:
    ask: "Some criteria could not be verified."
    choices:
      continue:                       # go on as a success, keeping the QA report
        outcome: success
        comment: optional
        outputs: { passed: true, accepted_unverified: "{{ gate.comment }}" }
      answered: {}                    # re-run QA with the evidence
      stop: { outcome: fail, comment: optional }
```

### Rules the validator enforces

- no cycles in `needs`; no unknown steps, roles, inputs or outputs
- two steps that can run at the same time (neither needs the other) must not both be able
  to edit files: make one role `readonly: true` or order them with `needs`
- prompts use only `inputs`, `run.id` and `attempt` (after-tasks also `run.status` and
  `run.failure`); inputs only reference ancestors (after-tasks also main steps and `run.*`)
- after-tasks have no `needs`, and only after-tasks have `trigger`
- a `script` names an existing, executable file of `scripts/`; only script steps have `poll`
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

## Recover a run

A run that was canceled partway, failed (including "manager lost" when its manager was
archived) or was archived can be resumed from the step it reached, without repeating the
steps that completed:

1. `list_runs` with `archived: true` shows each run's `status`, `failure` and
   `restartableFrom`: the steps you can restart from (main-graph steps whose `needs`
   completed).
2. Pick the first step that did not complete, usually the one that was running.
3. `restart_run` with `runId`, `stepId` and a `note` saying what changed since it stopped.
   That step and everything after it run again; earlier steps keep their outputs.
   - `takeOver: true` makes you the run's manager (you must be an agent of the run's
     workspace). Then run it as a manager: `get_run` (`view: "full"` for the earlier steps' reports and
     outputs), then `start_step` the ready steps.
   - Without it, the run's manager is woken, or a new Playbook Manager is created in the
     run's workspace if the old one was archived.

`restart_run` refuses an active run (cancel it first), a step whose needs did not complete,
and a workspace that already has another active run. A new run cannot start mid-way: to
skip work that a lost run did, restart that run rather than starting a new one.

Paseo archives an agent's children with it. If a coordinator that created the manager is
archived, the run does not fail: a new Playbook Manager takes it over and restarts the
steps whose agents were archived too. Archiving the manager itself still fails its active
run; recover it as above.
