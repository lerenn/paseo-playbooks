---
name: paseo-playbooks
description: Write or change paseo-playbooks playbooks and roles (.paseo/plugins/playbooks/). Use when asked to create, edit, review or debug a playbook, a role, playbook inputs/outputs, gates or loops for the Paseo Playbooks plugin.
---

# Writing paseo-playbooks playbooks

The paseo-playbooks Paseo plugin lets a **Playbook Manager** agent run a playbook: each
step runs as a subagent, the plugin enforces the graph, and humans approve gates in the
Playbooks panel. You write the playbooks; the plugin validates them.

**Always finish by calling the `validate_playbooks` tool and fixing every error it reports.**
It uses the same checks as the Playbooks panel. Its result is compact (`results[]`: `id`, `valid`, `errors`, and, when the file parses, `title`, `hidden`,
`inputs` (names), `steps` (ids), `after` (task ids), plus `source`, and `ref` or `note` when present); pass `view: "full"` for every playbook in detail (large: add `playbookId`) or
`playbookId` for one. `list_playbooks` takes the same two options.

## Layout

Everything lives in the repository, under `.paseo/plugins/playbooks/` or the shorter
`.paseo/playbooks/` (both are loaded; use one):

```text
.paseo/plugins/playbooks/
├── defaults/
│   ├── main.yaml              # optional: repo-wide agent defaults
│   └── manager.md             # optional: repo-wide instructions for every run's manager
├── pr.yaml                    # a playbook; its id is the file name ("pr")
├── release.yaml
├── roles/
│   └── reviewer/
│       ├── role.yaml          # title, readonly, agent
│       └── instructions.md    # the role's system prompt (required, non-empty)
├── sidekick/                  # optional: this project's Sidekick (see "The Sidekick")
│   ├── sidekick.yaml          # sidekick: { provider, model, mode, thinking, watch }
│   └── instructions.md        # repo-specific instructions added to its built-in rules
└── scripts/
    └── wait-pr-merged.sh      # optional: executables for script steps
```

- Every top-level `*.yaml` or `*.yml` file is a playbook. Shared settings live in folders, so no file
  name is reserved.
- Each of the two folders is self-contained: a playbook uses the `roles/` and
  `defaults/` (and `scripts/`) of its own folder. The same playbook id in both folders is an error.
- **Profiles**: `profiles/<name>/` in `.paseo/plugins/playbooks/` is an extra opt-in repository with this
  same layout (playbook files, `roles/`, `defaults/`, `scripts/`); no other format. The folder itself is the
  `default` repository, on unless the user turns it off for a project. The user turns profiles on per project (Profiles tab of the Playbooks screen, or the panel's dropdown; off by default, applies to all workspaces of the project).
  A profile's playbook is `<profile>:<id>` (`louis:deploy`) and resolves roles and sub-playbooks only inside
  its profile. A bare id shared by two repositories is ambiguous: use `default:deploy` or `louis:deploy`.
- Ids (playbooks, roles, steps, inputs, outputs) use lowercase letters, digits, `-` and `_`,
  and start with a letter.
- A playbook refers to a role by its directory name. Roles are shared by playbooks.

## The Sidekick

A project may have one Sidekick: a coordinator agent shown in a column beside the Playbooks screen (one tab
per project). It watches the project's runs, judges which decisions could be automated, and sends
subagents to change the playbooks in pull requests that a human merges. Its prompt forbids it to edit files or run commands itself.
It is defined by the `sidekick/` folder (a folder, so it never takes a playbook id: a playbook named
`sidekick.yaml` and `sidekick/sidekick.yaml` coexist). Without that folder the project has no Sidekick, and
its tab offers "Create the Sidekick files".

```yaml
# sidekick/sidekick.yaml (all fields optional)
sidekick:
  model: claude-opus-5-5        # provider, model, mode, thinking: as an agent block
  watch: [gate.escalated, run.failed, run.manager_lost]   # event types or globs, for this project's runs
  subagents: { provider: claude, model: claude-sonnet-5-5, mode: acceptEdits }   # what it creates for jobs (default claude / claude-sonnet-5-5; mode defaults to its own)
  session: { restart_above_tokens: 300000 }   # hand off and restart when its context grows past this (default 300000)
  runs: { max_concurrent: 5, confirm_bulk: true }   # rules for the runs it starts; max_concurrent unset means unlimited, confirm_bulk defaults to false
```

`sidekick.runs` is enforced by its prompt only, not by the plugin. Its prompt also forbids it to edit files or run
commands itself: it sends subagents for that work. `sidekick/instructions.md` holds the repository's rules for it;
they add to its built-in rules and never replace them. `validate_playbooks` reports errors in both files.

## defaults/main.yaml

```yaml
tiers:                 # named agent settings, referenced by `agent: { tier: <name> }`
  cheap:               # a list is a chain: when claude is out of tokens, the step moves to the next entry
    - { provider: claude, model: claude-haiku-5-5 }
    - { provider: codex, model: gpt-5-mini }
  worker: { provider: claude, model: claude-opus-5-5 }
  advisor: { provider: claude, model: claude-opus-5-5, thinking: high }
agent:                 # defaults for every step
  tier: worker
  mode: bypassPermissions
manager:               # settings of the manager agent when Start creates a new one
  mode: default
  compact: { above_tokens: 150000 }  # when to /compact the manager: never | on_step | on_gate_decided | { above_tokens: N } (default shown)
  # lifecycle: always_on   # repo-wide default of a playbook's `manager: { mode }`: always_on (default) | none (here `mode` is the manager agent's permission mode)
providers:             # provider failover
  exhausted_for: 1h    # an exhausted provider/model is skipped this long, then tried again (default 1h)
  on_exhausted: fail   # when every provider of a role is out of tokens: fail (to the manager, default) | wait (restart by itself)
  # max_wait: 12h      # with wait: give up and fail to the manager after this long (default: no limit)
  fallback: [codex/gpt-5.5, claude/claude-opus-5-5]  # provider/model targets every step falls back to, after its own tier (default none)
timeout: 1h            # default step timeout (optional)
role:                  # defaults for agent steps, in the shape of a step's `role:` block
  silence: 30m         # remind a step agent after this long without activity (default 30m; off to disable)
  archive_agents: true # archive step agents once the run no longer needs them (default true)
workspace:             # what happens to the workspace a run created with newWorkspace
  archive: on_end      # never (default) | on_end: archive it when the run completes or is canceled
  keep_failed: true    # keep it when the run failed or lost its manager (default true)
isolation: none        # none (default) | worktree | { mode: worktree, submodules: none | all | [paths], base: <branch> }: see "Isolated runs"
```

Agent settings (`provider`, `model`, `mode`, `thinking`) merge field by field. Precedence:
step > role > playbook > `defaults/main.yaml` > the manager's own provider and model.
Any mode is allowed; an unset mode uses the provider's default.

A tier is a block of `provider`, `model`, `mode` and `thinking` (all optional) defined once under `tiers:`.
Any `agent` block (in `defaults/main.yaml`, its `manager`, a playbook, a role's `role.yaml`, a step's
`role: { agent }`, a role decider's `decider: { agent }`) may name one: `agent: { tier: cheap }`. The tier's
fields come first, the block's own fields override them, and the layers then merge as above (a field a
layer leaves unset still comes from a lower layer). An unknown tier is an error. Switching provider is
one edit of the tiers.

A tier may also be a list of targets (`provider`, `model`, `mode`, `thinking` each): the first is the
primary, the rest are fallbacks. When a step agent's turn fails because its provider is out of tokens
(quota, rate or usage limit, no credits), the plugin restarts the same attempt on the next entry with
the same brief, without using a `retry`, records the exhausted `provider/model` in `run.exhausted` (`{ target, at }`) for
`providers.exhausted_for` (default `1h`; later agents skip it until then, after which it is tried again;
very short values re-probe a failing provider), logs a `provider_exhausted` line and tells the manager. When every entry is exhausted the failure goes
to the manager as usual, unless `providers.on_exhausted: wait`: the step then stays running with
`attempt.waiting { since, until }`, no retry is used, and the plugin restarts the attempt at `until` (the
earliest end of `exhausted_for`; it waits again if the provider is still out) until `providers.max_wait`
(default: no limit) is spent. Do not nudge or complete a waiting step. A multi-entry tier cannot be combined with inline `provider`, `model`, `mode`
or `thinking` on the same `agent` block: define another tier. On `manager` it only picks the first
entry when a manager is created; the manager never switches mid-run.

`providers.fallback` (a list of `provider/model`) is appended to every step agent's chain, after its
tier's own entries (duplicates skipped), so a role with a single model still moves on when it runs out.
A fallback keeps the role's `mode` and `thinking` only on the same provider. Out of tokens is detected
on a failed turn (its error text) and on a turn that ends on the provider's short notice as its last
message (Claude Code's "You've hit your weekly limit · resets …"); the patterns are in `server/quota.ts`.

The manager can pick a model for one attempt: `start_step`, `nudge_step` and `restart_run` take
`model: provider/model` (checked against the provider's models, as `list_models` shows them) and
`thinking`. On `nudge_step` a new agent on that model takes over the same attempt (no retry used; the
old agent is archived): the way to unstick a step whose provider is out with no fallback left.
`get_run` shows each step's `model` (compact) and, per attempt, the agents and models it ran on with
why (`chain`, `model`, `failover`, `resumed`) in view `full`.

## Manager instructions

The Playbook Manager has no role: its protocol is fixed. A repository adds to it with
`defaults/manager.md` (every run, non-empty), and a playbook with `manager: { prompt: | … }`.
The manager gets them after its protocol, as a list: the repository's first, then the
playbook's, then each sub-playbook's (steps and after-tasks, any depth, each playbook once):

```text
Instructions for this run (they add to the rules above, never replace them):
- repository: <defaults/manager.md>
- pr: <pr.yaml's manager.prompt>
- release: <release.yaml's manager.prompt>
```

They arrive in `start_playbook`'s result, or in the kickoff when the panel hands a run to a
manager. A batch's manager gets the repository's, the singleton's and its own stage's
sub-playbooks'. Use them for how to run the playbook (what to check before accepting a step,
what to tell the human), not for the steps' work: that goes in roles and step prompts.

## roles/<id>/role.yaml and instructions.md

```yaml
title: Reviewer
readonly: true         # must not edit files; enforced by a git check after each step
agent: { thinking: high }
```

`instructions.md` is the role's system prompt: what the role does and returns. The plugin
appends the step protocol (allowed outcomes, required outputs, `report_step_result`, and
waiting inside the turn with a bounded foreground poll, never on a Monitor, background
command or timer).

A `readonly` role may still run commands (tests, linters) but must leave tracked files,
the index and HEAD unchanged; build output in ignored files is fine.

## A playbook

```yaml
title: Pull request
description: Investigate, implement, open a PR and babysit it until it is green.
agent: { model: claude-opus-5-5 }          # optional playbook-wide settings
concurrency: 1                             # optional: max active runs (or held blocks) in the project
manager: { prompt: Check the PR exists before accepting implement., compact: on_step, mode: always_on }  # optional: prompt is added to the manager's instructions; compact overrides the default; mode: none = no manager agent, the plugin drives the run (see "Runs with no manager")
workspace: { archive: on_end }             # optional: overrides defaults/main.yaml's workspace block
isolation: { mode: worktree, submodules: none }  # optional: each run works in its own git worktree (see "Isolated runs"); the string form `isolation: worktree` also works
hidden: false                              # optional: true moves it to the panel's collapsed "Hidden playbooks" section (for one meant as a sub-playbook or after-task; it can still be started from there or by start_playbook)

inputs:                                    # the Start form; the manager fills them from chat
  request: { type: string, required: true, description: What to change }
  base_branch: { type: string, default: main }

outputs:                                   # the run's result
  pr_url: { type: string }                 # no value: auto-matched from a step output named pr_url
  pr_number: { type: number, value: "{{ steps.implement.outputs.pr_number }}" }

steps:
  - id: investigate
    role: { name: investigator, prompt: "Request: {{ inputs.request }}" }
    inputs: [request]                      # list form: every name auto-matched
    outputs:
      plan: { type: string }

  - id: implement
    role:
      name: implementer
      prompt: |
        Request: {{ inputs.request }}
        Plan: {{ inputs.plan }}
    needs: [investigate]
    inputs: [request, plan, base_branch]
    outputs:
      pr_url: { type: string }
      pr_number: { type: number }
      branch: { type: string }
    retries: 1
    timeout: 1h

  - id: review
    role: { name: reviewer, prompt: "Review {{ inputs.pr_url }}" }
    needs: [implement]
    inputs: [pr_url]
    outputs: { findings: { type: string } }

  - id: babysit
    role: { name: babysitter }
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
| `role` / `gate` / `playbook` / `script` / `handoff` / `branch` / `fanout` | Exactly one, as a block: an agent step, a human gate, a sub-playbook, a script the plugin runs itself, a hand-off to a singleton playbook, a branch, or a fan-out of one run per list item (see "Step kinds", "List values and fan-out steps" and "Singleton playbooks and hand-off steps" below). |
| `when` | Run the step only for some values of the run's inputs: `{ env: prd }` or `{ env: [stg, prd] }`, or on the step's own loop count, `{ loop: ">=2" }`; otherwise it is skipped (see Conditional steps). |
| `queue` | A singleton's stages only: `{ mode: fifo }` (default, one job per batch) or `{ mode: merge }` (every waiting job per batch). |
| `settle` | Role or script steps: `{ output: <name> }`, a string output holding YAML per job id (`{ outputs: {...}, outcome?, reason? }`). When the step completes on a batch of a singleton pipeline, the plugin settles those jobs itself, as `settle_job` would; `complete_step` refuses entries that do not apply. Has no effect outside a batch. |
| `inputs` | List of names (auto-matched) or map of name → source (`"{{ playbook.inputs.x }}"`, `"{{ steps.<id>.outputs.y }}"`) or `~`. |
| `outputs` | Typed values the step must return with any outcome except `failure` (a failure report skips output validation). All are required then. |
| `outcomes` | Default `[success, failure]`. See "Outcomes" below. |
| `on` | Per outcome: `complete`, `end`, `{ end: <playbook outcome> }`, `fail`, `{ goto: <earlier step>, max_loops: N }`, or `{ ask: "<text>", goto: <step>, max_loops: N, choices: {...} }` (agent steps; a choice may `goto` a step or end the step with an `outcome` and `outputs`; see Loops). |
| `retries` | Extra attempts after `failure`. |
| `timeout` | `30m`, `2h`…, or a template of the step's inputs (`"{{ inputs.release_timeout }}"`), rendered when each attempt starts; an empty value falls back to the default timeout, a value that is not a duration fails the start (or the run's start, when it only depends on the run's inputs). Expiry counts as a failure. The agent is reminded shortly before. If its work turns out done, `nudge_step` it: its next report replaces the timeout failure. |

### Step kinds

Each kind is a block under its keyword; an option that only one kind uses goes in its block.
A plain string (`role: reviewer`) is refused, and so is a kind's option written on the step
(`prompt:` beside `role:`): the error says what to write instead. Unknown keys in a block are
refused.

```yaml
- id: review
  role: { name: reviewer, prompt: "Review {{ inputs.pr_url }}", silence: 1h, archive_agents: false, agent: { thinking: high }, completion: { auto: [success] } }
- id: approve
  gate: { question: Ship it?, choices: { ship: ~, hold: { comment: required } } }
- id: wait_ci
  script: { run: wait-ci.sh, poll: 30s }
- id: release
  playbook: { name: release }
```

Write a block in flow style when it fits on one line, and in block style when a value spans
several lines:

```yaml
- id: implement
  role:
    name: implementer
    prompt: |
      Request: {{ inputs.request }}
```

| Block field | Meaning |
| --- | --- |
| `role.name` | Required: the role (a directory of `roles/`). |
| `role.prompt` | Template; may use only `{{ inputs.<name> }}`, `{{ run.id }}`, `{{ worktree }}` (the run's worktree, else the workspace), `{{ run.jobs }}` (a singleton batch's open jobs, as YAML), `{{ attempt }}` (retries), `{{ loop }}` (times a `goto` sent the run back through this step: 0 on the first pass). |
| `role.silence` | After this long without agent activity (default `30m`, or `off`), the plugin asks the agent once to report or say what it is waiting for, and tells the manager. |
| `role.archive_agents` | When the step completes, or its run or after-task ends, its agents are archived, and an attempt's agent is archived when the next attempt starts (default `true`). `false` keeps them, e.g. to debug. |
| `role.completion.auto` | List of the step's outcomes the plugin applies itself when the agent reports them (`completion: { auto: [success, merged] }`), as `complete_step` would, then starts the agent and script steps that become ready. The manager is not woken (its inbox gets a line) and must not call `complete_step` for them. Any other outcome, every failure and every `ask` outcome (refused in the list) stays reported and wakes the manager. So does an outcome whose application would end the run, open a gate (a gate step, a loop limit) or make a gate, hand-off or fan-out step ready, and any step of a batch. |
| `role.agent` | Step-level agent settings, or `{ tier: <name> }` (a tier of `defaults/main.yaml`) with fields that override it. |
| `gate.question` | Required: the message shown on the gate. |
| `gate.decider` | Who decides the gate besides a human in the panel: `{ by: human \| manager \| role, role: <id> }` (default `{ by: human }`). See "Who decides a gate". |
| `gate.choices` | The buttons, in order. Each key is an outcome, with `label`, `comment: none \| optional \| required` and `color: primary \| neutral \| success \| warning \| danger` (theme colours; default primary for the first, neutral for the others). Without `choices`, the default Reject is `danger`. |
| `script.run` | Required: an executable of `scripts/` (see "Script steps"). |
| `script.poll` | Rerun the script this often (`30s`, `1m`) while it exits with 75. |
| `script.wake_on` | Needs `poll`. A list of `{ types: [<event type or glob>…], filter: { <payload field>: <value> } }`: a matching bus event (the types of `subscribe_events`; `filter` matches payload fields by equality) runs a check at once instead of waiting for the poll, which stays as the safety net. See "Script steps". |
| `queue.admit` | On a singleton's stage, inside `queue:`: `{ script: admit_x.sh, poll: 10m, wake_on: [...] }` (`poll` required, `wake_on` as for scripts). The plugin runs the script on the stage's waiting jobs and it says which may join. See "Admission on a stage's queue". |
| `playbook.name` | Required: a playbook of the same folder (see "Sub-playbooks"). |

`outputs`, `outcomes` and `timeout` stay on the step (agent and script steps share them).

A gate's outcomes are the keys of its `choices` (default: `approved` with label Approve, and
`rejected` with label Reject and an optional comment). The panel shows
one full-width button per choice with where it leads (→ End, → End Release inside a block,
→ Implement, → Fail run). A choice with `comment: optional` or `required` opens a text box with Send; the comment goes
to the manager and, on a `goto`, to the target step as feedback.

Feedback for a loop (a `goto` back to an earlier step) travels in the `summary` of the manager's
`complete_step` call (or the gate comment), never in `outputs`: `outputs` only accepts the outputs the step
declares (`unknown output "fix" (declared: ...)` otherwise). `request_gate` also needs its own `summary`.

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

A step with `script: { run: <file> }` runs an executable from the folder's `scripts/`, with no
agent and no manager: the plugin starts it as soon as it is ready and completes it from the
result. Use it for deterministic work, above all **waiting** (a PR merged, a deploy
finished, a lane clear), so that no agent spends turns polling:

```yaml
steps:
  - id: wait_dev_lane
    script: { run: wait-dev-lane-clear.sh, poll: 1m }   # check every minute while it says "not yet"
    timeout: 2h                 # then fail (retries apply)
    inputs: [services]
    outputs: { lane_head: {} }
  - id: dev_release
    needs: [wait_dev_lane]
    role: { name: env_releaser }
```

The script contract:

- **The file:** a plain name in `scripts/` (no path), executable (`chmod +x`). Its
  shebang picks the language: `#!/usr/bin/env bash`, `#!/usr/bin/env python3`… It runs in the
  run's worktree, with the daemon's environment.
- **Inputs** come as environment variables, never in a command line:
  `PLAYBOOK_INPUT_<NAME>` (upper case; `services` → `PLAYBOOK_INPUT_SERVICES`), plus
  `PLAYBOOK_RUN_ID`, `PLAYBOOK_STEP_ID`, `PLAYBOOK_ATTEMPT`, `PLAYBOOK_CHECK` (1, 2, … within
  the attempt), `PLAYBOOK_WORKSPACE` and, after a `goto`, `PLAYBOOK_FEEDBACK`.
- **Exit code:** `0` = done; `75` = not yet, run me again after `script.poll` (without `poll`, 75 is a
  failure); anything else = `failure`.
- **Result:** on success, the last line of stdout may be a JSON object
  `{"outcome": "...", "summary": "...", "outputs": {...}}`, each key optional. `outcome`
  defaults to the first outcome, so a script can branch (`outcomes: [merged, closed]` with
  `on.closed`). Outputs are checked against `outputs` like an agent's report; a wrong one fails
  the attempt. On failure, `summary` (or the last stderr line) says why.
- **Checks must be idempotent and short:** each check looks once and exits. The plugin does
  the waiting between checks, and it reruns the current check after a daemon restart.
  A script must not edit the checkout (the concurrency rule does not check scripts).
- There is no prompt or agent; `inputs`, `outputs`, `outcomes`, `on`, `retries`,
  `timeout` and `needs` work as for agent steps. A failure with retries left runs again by
  itself; the manager is woken only with the final result. Without `timeout` (here or in
  `defaults/main.yaml`) a polling script waits forever.
- **Waking on events:** `script: { run: check.sh, poll: 10m, wake_on: [{ types: [job.advanced, job.settled], filter: { playbook: other_pipeline, stage: production } }] }`
  runs a check as soon as a matching event is emitted (another pipeline's job events, a step or run of
  another run…), then goes back to polling. `poll` is required: an event is a hint that something may have
  changed, never the truth, so the script still looks. A check already running is not interrupted: a burst of
  events during it causes one more check after it. Checks of a step are at least 5 s apart and never overlap.
  Events about the step itself (same run and `stepId`) never wake it. The step's sheet says what started each
  check: first run, poll, or "woken by <type>". Nothing is emitted for a wake-up.
- Pausing the run lets a running script keep checking; its result waits for the resume.
  Canceling the run, or a `goto` that resets the step, kills it.

### Conditional steps

`when` runs a step only for some values of the run's inputs (or, inside a sub-playbook, of
the block's inputs). Values are checked against the input's type. There is no expression
language: only equality.

```yaml
steps:
  - id: go
    when: { env: prd }          # only the prd run asks for a human go
    gate: { question: Release to prd? }
  - id: release
    needs: [go]                 # a skipped step counts as done: release starts at once on dev
    role: { name: env_releaser }
```

A skipped step's outputs are unset: a later step may read them only if it has the same
`when`. A `when` on a playbook step applies to every step of the block. After-tasks have none.

`when: { loop: ">=1" }` tests the step's loop count: how many times a `goto` (or an `ask`, or an
approved loop-limit gate) sent the run back through the step; 0 on the first pass. It takes a number
(equals), a comparison (`">=2"`, `"<3"`, `"==1"`) or a list (any holds). An input named `loop` wins over
it. It does not apply to a playbook step. Prompts read the same count as `{{ loop }}`.

`when` also tests what earlier steps found: `steps.<id>.outputs.<name>` or `steps.<id>.outcome` (the step
must come before it through `needs`). A test is a value, a list (any of), or `{ empty: true }` / `{ empty: false }`
(output unset or empty / set); all tests of a `when` must hold.

#### Branches: if / else-if / else

A `branch` step lists cases in order. The plugin takes the first case whose `if` holds (the last has no `if`: the
`else`, required) and completes the step with that case's name as its outcome. Steps of a case test it in `when`;
the others are skipped, and a skipped step counts as done, so a later step that needs all of them is the join.

```yaml
steps:
  - id: route
    needs: [approve]
    branch:
      cases:
        - { name: service, if: { steps.prs.outputs.kind: service } }
        - { name: infra, if: { steps.prs.outputs.kind: [infra, docs], env: prd } }
        - { name: other }                      # the else
  - id: trains
    needs: [route]
    when: { steps.route.outcome: service }
    role: { name: releaser }
  - id: by_hand
    needs: [route]
    when: { steps.route.outcome: [infra, other] }
    gate: { question: Merge and apply by hand? }
  - id: done
    needs: [trains, by_hand]
    gate: { question: Done? }
```

A case may end the run: `{ name: nothing, if: {...}, end: nothing_to_do }` (`end: true` for a plain end, else an
`outcomes` entry of the playbook). A gate `question` and an `ask` text may read `{{ playbook.inputs.<name> }}` and
`{{ steps.<id>.outputs.<name> }}` of earlier steps, e.g. `question: "Merge {{ steps.scan.outputs.prs }}?"`.

`validate_playbooks` refuses a missing or misplaced `else`, an unreachable case (an earlier case holds whenever it
does), duplicate names, and unknown steps, outputs, outcomes or values. A branch does not apply to after-tasks or
singleton stages. `get_run` shows the case taken (`chosen`) and why a step was skipped.

### List values and fan-out steps

A variable may have the type `list`: a JSON array of strings, numbers, booleans or flat objects of those (no
nesting), at most 200 items and 32,000 characters. It is stored and rendered as its JSON text, so
`{{ steps.x.outputs.items }}` shows `["a","b"]` anywhere a template is rendered (a gate question included). A script
reports one as a JSON array in the last line's `outputs`; an agent reports it as a JSON string.

A **fan-out step** (`fanout:`) starts one run of a playbook of the same folder per item of a list, each in its **own new
workspace** with its own Playbook Manager, keeps at most `max_active` going, and completes when every run has ended:

```yaml
- id: spawn
  needs: [list]
  inputs: { items: "{{ steps.list.outputs.items }}" }   # a list output of an earlier step
  fanout:
    playbook: batch_item                                  # not this playbook, not a singleton
    items: "{{ inputs.items }}"                           # exactly one reference to a declared input
    key: "{{ item.id }}"                                  # stable per item; default: the item (scalars only)
    inputs: { item_id: "{{ item.id }}", title: "{{ item.title }}" }   # the child's inputs
    workspace_name: "Batch: {{ item.id }}"                # optional, per item
    max_active: 3                                         # default 1, at most 50
    cancel_children: true                                 # default true
  on: { some_failed: complete }                           # default: some_failed fails the run
  timeout: 8h
```

- A manager that wants more runs in its own workspace: give its playbook `isolation: worktree`, and `start_playbook` with its
  `workspaceId` and no `newWorkspace` (the refusal "this workspace has an active run without isolation" is that rule).
- Per-item templates may use `{{ item }}`, `{{ item.<field> }}`, `{{ index }}` and `{{ inputs.<name> }}`. A reference that
  is not set makes that item `not_started` with the reason (never "(none)"). Keys must be unique (else the step fails).
- A child run is never started twice for one key: the plugin records each child (key, run id) in the step before creating
  it. After a daemon restart it follows the recorded children; a child whose creation was cut by the restart is
  `not_started`.
- `max_active` counts children being started or running. A child playbook's `concurrency` is respected: a child waits for a
  free slot. Duplicate-run refusal applies (a child with the same inputs as an active run is `not_started`).
- **Outcomes**: `all_completed` (continues), `some_failed` (any child failed, was canceled or not started; fails the run
  unless `on` routes it) and `failure` (bad list, duplicate keys, timeout). A child that fails never stops the others:
  the step waits for all, then reports.
- **Outputs** (fixed): `results` (list of `{key, runId, outcome, error?, output_<name>…}`; outcome is `completed`,
  `failed`, `canceled` or `not_started`), `total`, `started`, `completed`, `failed`, `canceled`, `not_started` (numbers),
  `any_failed` (boolean). An empty list completes at once with `all_completed`.
- Canceling or failing the parent run, resetting the step with a `goto`, or its `timeout` cancels the active children and
  drops the waiting ones (`cancel_children: false` leaves them running). Archiving the ended parent does not touch them.
- A loop works with the existing mechanisms: a script step after the fan-out with outcomes `[done, more]` and
  `on: { more: { goto: list, max_loops: 10 } }`. Earlier passes' children stay viewable.
- The plugin does the waiting (no agent, no tokens). Each child has its own manager: set `manager:` on the child playbook
  to make it cheap.

### Singleton playbooks and hand-off steps

A **singleton playbook** is a pipeline that takes work (**jobs**) from other runs: one
long-lived run per project, in one shared workspace. Its top-level steps are **stages**,
ordered by `needs`; jobs move through them.

```yaml
# release_trains.yaml
title: Release trains
singleton: { branch: main }            # its workspace branches off it (default: the default branch)
inputs:
  pr_url: { type: string, required: true }   # each job's
outputs:
  report: { type: string }                   # each job's
outcomes: [shipped, ejected]                 # each job's, when it leaves the pipeline
steps:
  - id: dev
    playbook: { name: train }                # a hidden playbook: release, wait, QA
    inputs: { env: dev }                     # constants only
    queue: { mode: merge }                   # every waiting job is in the same batch
    retries: 2                               # failed batches a job may be retried here
  - id: stg
    needs: [dev]
    playbook: { name: train }
    inputs: { env: stg }
    queue: { mode: merge }
  - id: prd
    needs: [stg]
    playbook: { name: train_prd }            # its own file, with a go gate first
    queue: { mode: merge }
    retries: 3                               # "Not now" waits for the next batch
```

- **Stages:** each has a waiting list and runs **one batch at a time**. A batch is an
  ordinary run of the stage's steps, with its own Playbook Manager in the shared workspace;
  the stage's previous manager is archived when the next batch leaves. Stages run in
  parallel.
- **`queue: { mode }`:** `fifo` (default) takes the oldest waiting job alone; `merge` takes
  every waiting job (a merge queue). Only on a singleton's top-level steps.
- **Moving on:** when a batch completes, its jobs still open pass the stage and wait at the
  next ones. A job that passed every stage leaves the pipeline with the first outcome; all
  `outputs` must be set by then. When a batch fails, its jobs wait at the stage again, at
  the front, up to its `retries`, then fail. `goto` between stages is refused.
- **Jobs in steps:** every input of a singleton is each job's. Steps read the batch's jobs
  (inputs, and outputs set at earlier stages) through `{{ run.jobs }}`
  (`PLAYBOOK_JOBS` for scripts); wiring a job's input into a step is refused. A stage's
  `inputs` take constants, which a sub-playbook reads as its inputs (`when: { env: prd }`
  inside it works).
- **Settling:** the batch's manager calls `settle_job` for a job: without an outcome to set
  its outputs (a tag later stages read), with an outcome (`ejected`) to end it now.
  Better, a step can return them: `settle: { output: job_results }` makes the plugin apply
  that output (YAML per job id) when the step completes, so no job is forgotten. A
  singleton's `outputs` need no source; a hand-off gets them all only with the first outcome
  (a job ended early brings what it has).
- **Requeueing:** a batch that fails (a lost manager, a rejected gate) puts its jobs back at the stage by itself while the
  stage's `retries` allow; past them the jobs are `failed`. `requeue_job { runId, jobId, reason? }` (any agent except
  step and gate agents; `runId` is the pipeline or one of its batches) puts a **failed** job back: same id, inputs and
  outputs, it waits at the stages it has not passed and its failed rides start again, so the next batch carries it. Only
  a job handed off with `wait: false` (detached): a waiting hand-off was told "failure" and decides itself. Idempotent
  (an open job is left alone, `changed: false`); refused for a settled or withdrawn job, a job that passed every stage and
  an ended pipeline. Events: `job.reopened`, then `job.queued` (`via: reopened`).
- Every role a singleton uses must be `readonly` (batches share one checkout). A singleton
  cannot set `concurrency` or `after`, and cannot be a sub-playbook or an after-task. When no
  batch is running, its workspace is fast-forwarded to `branch` and its playbook read again.

#### Admission on a stage's queue (`queue.admit`)

A job's precondition (QA passed, a dependency deployed, a ticket state) may fail while the others are fine. A stage's
queue can run a script that decides, **per waiting job**, who may join the next batch; the others wait without blocking
them. No batch, no manager, no agent and no tokens are involved: the plugin runs the script itself, as it runs a script step.

```yaml
  - id: staging
    needs: [dev]
    playbook: { name: train }
    queue:
      mode: fifo                                   # or merge
      admit:
        script: admit_staging.sh                   # an executable of scripts/
        poll: 10m                                  # required: the safety net
        wake_on:                                   # optional, as for script steps
          - { types: [job.advanced, job.settled], filter: { playbook: qa_pipeline, stage: smoke } }
```

- **When it runs:** when jobs wait at the stage and one of these happens: the first look (a job joined an empty
  queue, or the daemon restarted: the check reruns, so it must be idempotent), a new job of **this** queue
  (`job.queued` of the pipeline for this stage: always on, never written in `wake_on`), a `wake_on` event,
  the `poll` timer, or a human choosing "Check again" on an escalation. One check per stage at a time; events during
  one cause one more after it, and checks are at least 5 s apart. A queue with no waiting job costs no check. The
  events its own check makes (`job.held`, `job.admitted`, `job.escalated` of this stage) never wake it. A check
  that runs longer than 5 minutes is killed and counts as failed. It is allowed on the first stage like any other.
- **Where:** it is not inside a batch, so it runs in the **pipeline's workspace** (the shared checkout the batches use,
  the script's `cwd`), from the folder's `scripts/`. If the file is missing there (it was added to the branch after
  the pipeline last refreshed, which happens when no batch runs) the plugin refreshes the workspace once; a workspace
  or script that still does not exist fails the check visibly. It must not edit the checkout.
- **Input** (environment): `PLAYBOOK_JOBS`, a JSON list of the stage's **waiting** jobs, oldest first, each
  `{ id, label, since, inputs }` (`since`: when it started waiting here; `inputs`: all of the job's own inputs, strings cut
  at 10,000 characters); `PLAYBOOK_STAGE` (the stage id; `PLAYBOOK_STATION` is its deprecated name, until 2027-02-12), `PLAYBOOK_PIPELINE` (the playbook id),
  `PLAYBOOK_RUN_ID` (the pipeline run), `PLAYBOOK_STEP_ID` (the stage), `PLAYBOOK_CHECK`, `PLAYBOOK_WORKSPACE`, and
  `PLAYBOOK_JOBS_OMITTED`. The list holds at most 100 jobs and 100,000 characters (at least one job always goes);
  the rest, `PLAYBOOK_JOBS_OMITTED` of them, are looked at by a later check once the first ones join or leave. Jobs a
  human admitted anyway are not in it.
- **Result:** the last line of stdout, a JSON object (the same keys under `outputs` work too):
  `{"admit": ["job_a"], "hold": {"job_b": "QA not passed"}, "escalate": {"job_c": "its dependency failed"}}`, each key
  optional. A job the script does **not name is held** with the reason "not admitted by the script" (the safe default).
  A job named in several keys gets the strictest (`escalate`, then `hold`, then `admit`). An id the script was not given
  is ignored, with a warning on the stage. Exit **75** ("not yet") or any failure, timeout or unreadable result line
  changes nothing: the next trigger retries, and a failure shows as an alert on the stage (checks so far, the message
  and the end of the output).
- **State:** each waiting entry has `held: { reason, checkedAt } | null` (null: it may join; `checkedAt` null: the
  first check has not run yet; a new job at a stage with `admit` starts held, so nothing joins before the script
  has spoken). `held` changes only when the verdict does: a script that holds a job for the same reason on every
  poll changes nothing and sends no event. `checkedAt` is when that reason was decided. Admission acts only on
  waiting jobs, before a batch starts: a job already in a batch is never held, and a job a batch retries (its batch failed)
  waits again admitted. A later check may hold an admitted job that has not joined yet.
- **Batches:** the next batch of a stage takes the oldest waiting job that is not held (`fifo`), or every one
  that is not held (`merge`). A held job never blocks the others: a held oldest job does not stop `fifo` from
  taking the next. Without `admit` on a stage, nothing is held. If the block is removed from the playbook while jobs
  are held, they join as usual; if the stage is removed, its jobs fail as they do for any removed stage.
- **Escalation:** `escalate` holds the job and opens a **human ask** on the pipeline run for that job (kind `admission`,
  with the stage as `stepId` and the job as `jobId`), question "Job <id> (<label>) cannot be admitted at <stage>:
  <reason>". It shows in the panel's "Needs you", in `list_gates` and in `get_run`, and `gate.opened` fires. A pipeline
  has no manager: a human answers in the panel, with an optional comment: **Check again** (`retry`: run the check now,
  the job stays held), **Withdraw the job** (`withdraw`: the job leaves the pipeline like a canceled hand-off, and
  its hand-off step ends `failure` with the reason; it is not retried) or **Admit anyway** (`admit`: the job may
  join and the script no longer holds it). One ask is open per job: the script escalating again does not open another. The
  ask closes by itself when the script admits the job or the job leaves the pipeline (withdrawn by its run, failed).
- **Events:** `job.held` (+ `reason`, only when the hold or its reason changes), `job.admitted` (+ `via: script | human`,
  `reason`: the human's comment) and `job.escalated` (+ `reason`, `gateId`), on the same payload as the other `job.*`
  events (`stage`, `jobId`, `playbook`...): a manager subscribes instead of polling.
- **Seeing it:** `get_run` lists each held job's reason per stage (`held: { <stage>: { reason, since, checkedAt } }`
  in the jobs section). The panel's stage shows a "Held" badge and the reason on each waiting job, since when it waits,
  when it was checked, and "Admission: checking" or "Admission: waiting, next check in ~Ns", with the alert of a failed check.
  The panel's status is live in memory: after a daemon restart it is empty until the next check.

A **hand-off step** gives a singleton a job and waits until the job leaves the pipeline:

```yaml
  - id: release
    needs: [approve]
    handoff: { name: release_trains }
    inputs: { pr_url: ~ }             # the singleton's inputs
    timeout: 48h                      # the whole pipeline, human gates included (or none)
    on:
      ejected: { goto: fix, max_loops: 2 }
```

- Its contract is the singleton's `inputs`, `outputs` and `outcomes` (plus `failure`); every
  outcome but the first needs an `on` entry (not `ask`).
- The plugin starts it and completes it; the manager never calls `start_step` or
  `complete_step` for it. Canceling the run, or a `goto` that resets the step, withdraws the
  job. While the run is paused, a result waits for the resume.
- When a batch carrying the job waits for a human (a gate or an ask), the manager is told, and
  told again once it is decided, so it can pass it on where it reports (a chat or a thread). The
  decision is made in the Playbooks panel, on the singleton's card: the gate belongs to the
  batch, not to the handing-off run.
- A hand-off that leads back to its own playbook is refused.

**Without waiting**, `handoff: { name: release_trains, wait: false }` (default `true`): the step
completes with the singleton's first outcome as soon as the pipeline takes the job, and the run
moves on.

- The job then belongs to the pipeline: it survives the run completing, failing or being
  canceled, is never withdrawn by it, and how it ends is recorded on the pipeline only (the run
  is not told, nor of the batch's gates). Its card still shows which run handed it off, and
  `{{ run.jobs }}` marks it `detached: true`.
- The step gives no outputs: reading `steps.<id>.outputs.*` from it is refused, and `on` may
  only name the first outcome or `failure` (the job could not be handed off).
- **Rework after an eject:** the batch's manager can start a new run of any playbook with
  `start_playbook(playbook, inputs, newWorkspace: true)`. It gets a new workspace (branched off
  the pipeline's) and its own Playbook Manager; the batch's manager does not manage it. Write
  in the singleton's playbook when to do it, e.g. in the prompt of the step that ejects:
  "after `settle_job(… outcome: ejected)`, call `start_playbook` with playbook `pr-to-prod`,
  inputs `{ pr_urls, ticket }` from the job, and `newWorkspace: true`".

### Sub-playbooks

A step with `playbook: { name: <id> }` runs another playbook of the same folder in place, like a
building block:

```yaml
steps:
  - id: pr
    playbook: { name: pr }       # its inputs match by name, or map them in `inputs`
  - id: approve
    needs: [pr]
    gate: { question: Release it? }
    on:
      rejected: { goto: pr }     # restarts the whole block, with the comment as feedback
  - id: release
    needs: [approve]
    playbook: { name: release }  # gets pr_url from the pr block's outputs
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
      role: { name: env_releaser }
      inputs: [env, release_timeout]
      outcomes: [success, no_deploy, failure]
      on: { no_deploy: { end: no_deploy } }   # nothing to deploy: end this block, say why
      timeout: "{{ inputs.release_timeout }}"
  # release.yaml
  steps:
    - id: dev
      playbook: { name: env_release }
      inputs: { env: dev, release_timeout: 5h }
      on: { no_deploy: end }                    # skip stg, the prd gate and prd
    - id: stg
      playbook: { name: env_release }
      needs: [dev]
      inputs: { env: stg, release_timeout: 4h }
      on: { no_deploy: end }
  ```
- `outputs`, `outcomes` and `timeout` do not apply to a playbook step (its `on` takes only `complete`, `end` and `fail`, and not on an after-task). A playbook that includes itself (directly or not) is an error.
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
Each one is an agent step (`role: { name, prompt }`), a gate, or a sub-playbook (`playbook: { name: <id> }`):

```yaml
after:
  - id: retro
    playbook: { name: retro }
    inputs:
      run_id: "{{ run.id }}"   # run values are always mapped explicitly
  - id: notify
    role: { name: reviewer, prompt: "Post a summary of run {{ run.id }} ({{ inputs.status }})." }
    trigger: manual      # a Start button on the finished run, or start_after_task (default: auto)
    inputs:
      status: "{{ run.status }}"
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
- Step and gate agents cannot call `get_run` (or `list_gates`). Other agents can read any run with it (read-only), and
  `list_gates` lists every open gate and ask across runs (a gate a decider left to a human shows `waitingForHuman`, `escalatedAt` and
  `escalationReason`; `subscribe_events` on `gate.escalated` tells agents when that happens; its `delivery` is `idle` by default, which holds the notice until the subscriber's turn ends, or `steer` to inject it into the running turn). A retro step that reviews the whole run gets it from
  the manager: tell the manager (in the playbook `description`) to put `get_run` with
  `view: "full"` in the step's brief. The default `get_run` view is compact (per step: status,
  outcome, attempts, turn end and the first 300 characters of the summary), without reports
  or outputs.
  `read_agent_conversation` (every agent but step and gate agents) reads any agent's conversation as text, newest page first,
  with reasoning and tool input opt-in and a `before` cursor for older entries.

### Variables

Types: `string`, `number`, `boolean`, `enum` (with `values: [...]`), `list` (a JSON array of strings, numbers,
booleans or flat objects; see "List values" for fan-out); each may have `required`, `default`, `description`.

Two namespaces: in a step's `inputs:` map, sources are `{{ playbook.inputs.x }}` and
`{{ steps.<id>.outputs.y }}`; in a `prompt`, you only read the step's own inputs as
`{{ inputs.x }}`. To use a value in a prompt, declare it as an input first.

An input without a source takes the same-named output of an **ancestor** step (a step it
needs, directly or not), else the playbook input with that name. If several ancestors
output that name, validation fails: map it explicitly. Nothing is chosen silently.

### Loops

`goto` must point to an earlier step that this one needs (or itself). It re-runs the
target and every step after it. The step or gate that looped hands its summary or comment
to the target as "Feedback to address". Reaching `max_loops` opens a "loop limit" gate; approving it
sends the target the step's feedback and the decision's comment ("On the loop limit, the human said: …"). A comment
from the manager or a role decider reads "the manager said"/"the role "x" said", whichever gate it is.

A `max_loops` inside a block holds per pass: when a `goto` from outside re-enters the block (an outer
loop over items, say), the counters of the block's own loops start again from 0. The outer
goto's counter keeps counting, and `{{ loop }}` is not reset (it counts every re-run of the step).

To let an agent step ask a human a question, give it an outcome that routes to `ask`:

```yaml
- id: investigate
  role: { name: investigator }
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

### Who decides a gate

Every gate is a human gate unless it names a `decider`: a gate step in its `gate:` block, an
`ask` in its transition, and a loop-limit gate on the `goto` that has `max_loops`:

```yaml
- id: approve
  gate: { question: Ship it?, decider: { by: role, role: gatekeeper } }
# on an agent step:
on:
  unsure: { ask: "Which way?", decider: { by: manager } }
  changes_requested: { goto: implement, max_loops: 3, decider: { by: role, role: gatekeeper } }
```

- `by: human` (the default): the manager asks the human in chat and relays the answer, or the
  human decides in the panel.
- `by: manager`: the manager may decide alone (`resume` with `byManager: true` and its reason
  as comment, shown as "by the manager"), or call `escalate_gate` with its reason and ask a human as
  for a human gate (this tells agents subscribed to `gate.escalated`).
- `by: role`: the plugin starts an agent with that role (it must be `readonly`) when the gate
  opens. It gets the gate, its choices, the run's inputs and the steps' summaries and
  outputs, and calls `report_gate_decision` with a choice or `escalate`, and its reason.
  Write in its `instructions.md` when it may decide and when it must leave the gate to a
  human. If it escalates, ends without deciding (after one reminder), or is archived, the
  gate goes to a human, with its reason in the gate's details.

A human can always decide first in the panel. The loop-limit gate of an `ask` choice's
`max_loops` follows the `ask`'s `decider`. `decider` on a `goto` without `max_loops` is an
error.

### Rules the validator enforces

- no cycles in `needs`; no unknown steps, roles, inputs or outputs
- two steps that can run at the same time (neither needs the other) must not both be able
  to edit files: make one role `readonly: true` or order them with `needs`
- prompts use only `inputs`, `run.id`, `run.jobs`, `worktree`, `attempt` and `loop` (after-tasks also `run.status` and
  `run.failure`); inputs only reference ancestors (after-tasks also main steps and `run.*`)
- after-tasks have no `needs`, and only after-tasks have `trigger`
- `isolation` is `none`, `worktree`, or a block `{ mode, submodules, base, allow_gitlink_removal }` (mistyped keys fail); a singleton cannot ask for `worktree`
- a `script` names an existing, executable file of `scripts/`; `poll` and `wake_on` go in the `script:` block; `wake_on` needs `poll`, names known event types and, in `filter`, fields of those types
- `queue.admit` only on a singleton's stage: `script` names an executable of `scripts/`, `poll` is required, `wake_on` follows the script rules (`admit` is not a flat field of the step)
- a `fanout` names a playbook of the same folder that is valid, not a singleton and not this one (directly or through
  another fan-out, hand-off or sub-playbook), maps every required input of it, reads a declared step input in `items`, and
  uses only `item`, `item.<field>`, `index` and `inputs.<name>` in its per-item templates
- a `handoff` names a singleton playbook of the same folder, and does not lead back to its
  own playbook; a singleton is never a sub-playbook or an after-task, its steps never wire a
  job's input, its roles are all `readonly`, and its stages do not `goto` each other;
  `queue` only goes on a singleton's top-level steps
- `when` names the run's inputs (never a singleton's: they are each job's) with values of their
  type; a skipped step's outputs are read only by steps with the same `when`
- no `next` key: chaining was removed; to run a playbook after another, write a parent
  playbook that includes both as sub-playbook steps

## Isolated runs (`isolation: worktree`)

By default every run works in its workspace's checkout, so a workspace holds one active run. With
`isolation: worktree` (per playbook, or repository-wide in `defaults/main.yaml`; the playbook's fields win)
the plugin gives each run a private git worktree, and several isolated runs may share one workspace.

```yaml
isolation: worktree                          # short form
isolation: { mode: worktree, submodules: [ops/api, ops/web], base: main }   # block form
```

- **Where**: `$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/worktrees/<runId>`, on a new branch
  `playbooks/<playbook>-<id>` off a freshly fetched `origin/<base>` (`base` default: the project's default
  branch). The path and branch show in `list_runs` and `get_run`.
- **Why a prompt, not a cwd**: Paseo pins an agent's directory to its workspace, so agents still start in the
  workspace. The plugin tells every manager and step agent (system prompt and first message) to work only in
  the worktree: absolute path, `cd <path> && ...` or `git -C <path>` for every command (the shell resets
  between commands), absolute paths for Read/Edit/Write, never edit the workspace checkout. `{{ worktree }}`
  puts the path in a prompt or in a role's `instructions.md`; without isolation it renders the workspace
  directory, so one prompt works both ways.
- **Guard**: when each step ends, the plugin compares the original workspace checkout (`HEAD` and
  `git status`, untracked files included) with its state at run start. Any change fails the step ("isolation
  guard", naming the changed paths) and is told to the manager. A `readonly` role's check covers the worktree.
  When the run ends the same check runs; on a change the worktree is kept and the manager is told.
- **Submodules** (`submodules`): `none` (default) leaves them empty: agents run
  `git submodule update --init -- <path>` for the ones they need (the preamble says so). `all` or a list
  links each as a detached worktree of the workspace's own clone of it, at the commit the worktree pins
  (fast, shares objects; a submodule the workspace never initialised is initialised in place).
- **Cleanup**: when the run completes or is canceled (and its after-tasks end), the plugin removes the worktree
  and its branch, and the history says so. A canceled run is an intentional end, so `keep_failed` does not apply
  to it: it is removed like a completed one. It keeps the worktree, with a `worktree_kept` history entry, when the
  run failed and `workspace.keep_failed` is true, when it has uncommitted changes (also after a cancel), or when the guard fired; it
  keeps the branch (not the directory) when the branch has commits on no remote. Restarting a run brings the
  worktree back on its branch. At daemon start the plugin deletes worktree directories whose run no longer
  exists. It never deletes outside its worktrees directory.
- **Fresh playbook**: an isolated run reads its playbook and roles from its worktree (a freshly fetched `origin/<base>`), not from the workspace checkout, so you do not need to fast-forward the workspace for new rules to apply (and must not while isolated runs are active). `start_playbook` says where the definition came from; if it warns that the workspace checkout's copy was used (fetch failed, or the playbook is missing/invalid on origin), the rules may be stale. The playbook must still exist, valid and isolated, in the workspace checkout to be started. `validate_playbooks` reports `source` per playbook (what a new run would load). `restart_run` keeps the run's frozen definition.
- **Gitlink guard**: after each step the plugin fails the step, naming the paths, if the run's branch deletes a submodule entry (mode 160000) present in its base; `isolation: { allow_gitlink_removal: true }` turns it off (default `false`). Agents are also told never to `git add -A`/`git add .`/`git commit -a`.
- **Concurrency**: isolated runs share a workspace freely; a run without isolation still needs the workspace to
  itself and is refused while an isolated run is active there (and the other way round). Singletons and release
  batches are never isolated.
- Scripts of an isolated run run in the worktree (`PLAYBOOK_WORKSPACE` is the worktree; the original is
  `PLAYBOOK_ORIGINAL_WORKSPACE`).

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

## Improve a playbook from its token spend

`get_analytics` (read-only; `days`, `playbook`, `projectId`, `limit`) sums what agents spent, by playbook, step
(with its role and model), role and model: tokens, peak context, and wasted attempts (retried, or whose
agent did not finish) with their tokens. Look for steps that use the most tokens, retry the most or fill their context,
and for a big model on a simple step; then propose a change to the playbook, role or model. `overhead` is the
managers' and gate deciders' share. Usage exists only for runs that ended turns after v0.58.0.

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
   - `workspaceId: <id>` moves the run to another workspace of the same project (no active
     run in it) when its own workspace was deleted or has another active run. A new Playbook
     Manager is created there; the history records the move. `create_workspace` makes a
     workspace; check out the run's branch in it first if the work lives there.

`archive_run` (`runId`, optional `force`) archives a run that has ended, like the panel's archive button: after `cancel_run` or a finished run, once its job is settled. It hides the run from the panel and from `list_runs` (without `archived: true`); `restart_run` still reopens it. It refuses an active run, and a run whose hand-off job is still open at a pipeline stage or batch unless `force: true`; archiving twice is fine.

`restart_run` refuses an active run (cancel it first), a step whose needs did not complete,
and a workspace that is gone or already has another active run (the message names that run and
suggests `workspaceId`). A new run cannot start mid-way: to
skip work that a lost run did, restart that run rather than starting a new one.

Paseo archives an agent's children with it. If a coordinator that created the manager is
archived, the run does not fail: a new Playbook Manager takes it over and restarts the
steps whose agents were archived too. Archiving the manager itself still fails its active
run; recover it as above.

## Runs with no manager

`manager: { mode: none }` (default `always_on`; repo-wide default `manager: { lifecycle: none }` in `defaults/main.yaml`;
`on_demand` is not supported yet) makes a run with no Playbook Manager agent: nobody starts it in chat, and
`managerAgentId` is empty. The plugin starts the ready agent steps (as top-level agents of the run's workspace, not
subagents), applies every outcome the step agents report, and opens the gates: a human gate shows in the panel
(Review / Needs you), a role gate starts its decider, and a `by: manager` gate is a human's. A failure (an outcome whose
transition is `fail`, a step that ends without reporting, a timeout, a step that cannot start, a lost agent) stops the run
in its failed state with the reason in `failure`; `restart_run` and the panel's restart work as usual. Nothing is retried
unless the YAML says so (`retries`, `on`, `goto`). There is no stall handling beyond a step's `timeout`: with none, a step
that never ends is not touched. `start_step`, `complete_step`, `nudge_step`, `request_gate` and `escalate_gate` are refused on
such a run. A fan-out child uses its own playbook's mode.

With no manager, a human gate is shown in the panel and also put to the human in the conversation of the step agent just before it, when
that agent is still alive (`role: { archive_agents: false }`, idle): the plugin asks it to use `AskUserQuestion`, then `answer_gate`
(a tool only those step agents have). Answering in the panel or in the conversation closes the gate; the other surface is dismissed.
