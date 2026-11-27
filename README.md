# Paseo Playbooks

[![CI](https://github.com/lerenn/paseo-playbooks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lerenn/paseo-playbooks/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/lerenn/paseo-playbooks?style=flat-square)](https://github.com/lerenn/paseo-playbooks/releases)
[![Paseo >=0.16.0](https://img.shields.io/badge/Paseo-%3E%3D0.16.0-blue?style=flat-square)](https://github.com/getpaseo/paseo)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/lerenn/paseo-playbooks?style=flat-square)](https://github.com/lerenn/paseo-playbooks/stargazers)

**Contents:** [Why Paseo Playbooks](#why-paseo-playbooks) · [The workflow](#the-workflow) · [What makes it different](#what-makes-it-different) · [Meet the Sidekick](#meet-the-sidekick) · [Get started](#get-started) · [Documentation](#documentation) · [Development](#development) · [Status](#status) · [Reference](#reference)

> **Stop supervising every agent. Start shipping a repeatable engineering system.**

Paseo Playbooks turns "what happens next?" into versioned YAML. Investigate, implement,
review, test, ask for approval, wait, retry, and recover, with specialist agents for
judgment, scripts for facts, and explicit human gates for consequential decisions.

The Playbooks panel makes the entire process visible across every workspace:

![The Playbooks panel showing a running Docs check playbook as a graph](assets/panel.png)

## Why Paseo Playbooks

One coding agent can complete a task. An engineering system also needs to know:

- who investigates, implements, reviews, tests, and approves;
- which steps can run in parallel;
- what data passes between steps;
- how review loops are bounded;
- which decisions require a person;
- how to recover without replaying completed work;
- how to continue when a provider runs out of quota.

Paseo Playbooks keeps those answers in the repository. The graph is reviewed, versioned,
validated, and improved like other engineering code, not hidden in a chat or one long prompt.

## The workflow

This playbook investigates a request, implements it, reviews and tests in parallel, and
asks a human before merging. A reviewer can return work to the implementer at most twice.

```yaml
title: Pull request

inputs:
  request:
    type: string
    required: true

steps:
  - id: investigate
    role:
      name: investigator
      prompt: Investigate {{ inputs.request }} and write an implementation plan.
    inputs: [request]
    outputs:
      plan: { type: string }

  - id: implement
    role:
      name: implementer
      prompt: Implement {{ inputs.request }} using {{ inputs.plan }}.
    needs: [investigate]
    inputs: [request, plan]
    outputs:
      branch: { type: string }

  - id: review
    role: { name: reviewer, prompt: Review the implementation. }
    needs: [implement]
    outcomes: [ok, changes_requested]
    on:
      changes_requested: { goto: implement, max_loops: 2 }

  - id: test
    role: { name: tester, prompt: Run the relevant tests. }
    needs: [implement]

  - id: approve
    needs: [review, test]
    gate: { question: Merge this change? }
    on:
      rejected: { goto: implement }
```

- **Playbook:** the versioned workflow graph.
- **Role:** reusable instructions and agent settings.
- **Step:** role agent, script, gate, or nested playbook.
- **Outcome:** a declared result that routes to a permitted step.
- **Run:** durable state, history, outputs, workspaces, and recovery data.

## What makes it different

- **A graph is an enforced contract.** The plugin validates roles, inputs, outputs, scripts
  and transitions before a run, and refuses a transition the playbook does not allow.
  Loops are bounded by `max_loops`, and a gate is an explicit decision point. A run's own
  agents cannot approve their own human gate: a person decides it in the panel or in chat,
  or an agent outside the run relays the person's answer with `resume_gate` (turn that off
  with `gates: { on_behalf: deny }`). A gate that names `by: manager` or `by: role` as its
  decider can be decided without a person. See [who decides a gate](https://playbooks.paseo.lerenn.dev/reference.html#deciders).
- **Agents and scripts work together.** Specialists handle ambiguous judgment while scripts
  poll CI, deployments, queues, and external conditions.
- **Human control is visible.** Approval, rejection, deferral, and resume are first-class
  run operations in the panel and chat.
- **Interruption is recoverable.** Restart from a failed step, or recover a stuck manager
  (`recover_manager`, and automatically when its provider's quota runs out), without
  replaying unrelated work. Temporary workspaces can be retained and cleaned up deliberately.
  See [Known limits](#known-limits).
- **Isolation includes provenance.** A run with `isolation: worktree` reads its playbook and
  roles from its own private Git worktree, off a freshly fetched `origin/<base>`, and keeps
  that definition frozen for the run (`restart_run` reuses it). If the fetch fails, the
  workspace checkout's copy is used and the start says so. Definition refreshes, fallbacks,
  cleanup, and teardown are recorded.
- **Provider limits do not erase progress.** Agent tiers can fall back across providers;
  usage-aware selection and quota pacing preserve run state and history.
- **The system can improve safely.** The Sidekick proposes workflow changes through pull
  requests, and its prompt forbids it to edit files or run commands itself.
- **Every workspace has one operational view.** The panel shows live output, gates, loops,
  failures, history, analytics, quotas, and off-hours policy.

More of what the plugin does:

- **Burn rate limiting:** quota pacing against the provider's usage windows, with a maximum
  usable quota, closed hours, a burn rate per playbook, run priorities and exempt runs.
  See [Rate limits](#rate-limits) and the [reference](https://playbooks.paseo.lerenn.dev/reference.html#rate-limits).
- **Warden:** an opt-in periodic pass, with no LLM, that flags stale definitions, loops,
  blocked managers, slow steps, long-open gates, stalled runs and held runs.
  See the [reference](https://playbooks.paseo.lerenn.dev/reference.html#warden) and [Known limits](#known-limits).
- **Usage log and analytics:** an append-only log with one line of counters per agent turn (never a prompt or output), used to
  simulate moving roles to cheaper models, and an Analytics tab in the panel. See [Usage log](#usage-log) and the [reference](https://playbooks.paseo.lerenn.dev/reference.html#usage-log).
- **Panel tabs and languages:** the **+** button opens Analytics, Burn rate limiting, Off hours
  and Profiles as tabs, and the panel is translated into French and Simplified Chinese.
  See [Panel languages](#panel-languages) and [Profiles](#profiles).
- **Fan-out pools, pipelines and trains:** one run per item of a list, kept open by a work pool;
  singleton pipelines that batch jobs through stages. See the
  [reference](https://playbooks.paseo.lerenn.dev/reference.html#fanout) and [singletons](https://playbooks.paseo.lerenn.dev/reference.html#singletons).

See [the PR workflow](examples/.paseo/plugins/playbooks/pr.yaml),
[the release workflow](examples/.paseo/plugins/playbooks/release.yaml),
and [all example playbooks](examples/.paseo/plugins/playbooks/).

## Meet the Sidekick

Add a `sidekick/` folder beside your playbooks to give a project a long-lived coordinator.
The Sidekick watches runs, summarizes what needs attention, and sends subagents to improve
workflows in pull requests.

Its prompt forbids it to edit files or run commands itself. It delegates changes, starts
playbooks, keeps a short decision ledger, and can relay a person's own answer to a routine
gate while leaving production and security decisions with people.
See the [Sidekick reference](https://playbooks.paseo.lerenn.dev/reference.html#sidekick) and [The Sidekick](#the-sidekick) below.

## Get started

### Requirements

- [Paseo](https://github.com/getpaseo/paseo) `0.16` or later.
- A repository whose playbooks and roles you trust. Agent steps may run with powerful
  permission modes, including `bypassPermissions`.

Until v1.0, minor releases may change the playbook format in breaking ways. Pin the plugin
to a tested release tag (the [latest release](https://github.com/lerenn/paseo-playbooks/releases/latest)
is the usual choice) and read the release notes before upgrading:

```bash
paseo plugin install https://github.com/lerenn/paseo-playbooks.git --ref <latest tag>
paseo plugin update paseo-playbooks --ref <newer tag>   # to upgrade later
```

### Add your first playbook

```bash
mkdir -p .paseo/plugins
cp -R examples/.paseo/plugins/playbooks .paseo/plugins/
```

1. Edit a playbook and its roles under `.paseo/plugins/playbooks/`.
2. Validate it from a Paseo agent with `validate_playbooks`.
3. Open the Playbooks panel and press **Start**.
4. Watch the graph, answer gates, and inspect run history.

The [playbook-writing skill](skills/paseo-playbooks/SKILL.md)
teaches agents the format and validation rules.
Use `ask: "{{ report.summary }}"` on an outcome to show the first non-blank
line of the step's summary in the gate. Put the question on that first line.

For a full walkthrough, see [Getting started](https://playbooks.paseo.lerenn.dev/getting-started.html).

## Documentation

- [Overview](OVERVIEW.md) (also in [French](OVERVIEW.fr.md) and [Simplified Chinese](OVERVIEW.zh-CN.md))
- [Getting started](https://playbooks.paseo.lerenn.dev/getting-started.html)
- [Format reference](https://playbooks.paseo.lerenn.dev/reference.html#playbook)
- [How it works](https://playbooks.paseo.lerenn.dev/how-it-works.html)
- [Sidekick reference](https://playbooks.paseo.lerenn.dev/reference.html#sidekick)
- [Design and decisions](docs/adrs/2026-11-02-design.md) (one ADR per significant decision in [docs/adrs](docs/adrs))
- [Development and release process](#develop) and [Release](#release)

## Development

```bash
npm install
npm run typecheck
npm test
```

Install the local checkout, then reload the plugin:

```bash
paseo plugin install "$PWD"
paseo plugin reload paseo-playbooks
paseo plugin logs paseo-playbooks
```

See [AGENTS.md](AGENTS.md) for contributor guidance and the ADR policy.

## Status

Paseo Playbooks is an actively evolving pre-1.0 plugin. It is best suited to teams that
want AI-assisted engineering workflows to be explicit, inspectable, and repeatable.

Try one small workflow. Then tell us what the factory should learn next.

This README opening is based on the README proposal in [#316](https://github.com/lerenn/paseo-playbooks/issues/316) by @noor-latif (thank you).

## Reference

Everything below is the reference material that used to open this file, unchanged and in
its original order.

### Diagrams

The example playbook from the overview (fix, then review and test in parallel, then a human
gate), as a graph. The source is [assets/example-flow.mmd](assets/example-flow.mmd):

```mermaid
flowchart LR
  start([issue]) --> fix("<b>Fix</b><br/>developer")
  fix --> review("<b>Review</b><br/>reviewer, read-only")
  fix --> test("<b>Test</b><br/>tester, read-only")
  review -- ok --> approve{"<b>Merge?</b>"}
  test --> approve
  review -. "changes_requested, max 2" .-> fix
  approve -. rejected .-> fix
  approve -- approved --> done([done])

  classDef step fill:#2F6BF2,stroke:#2F6BF2,color:#FFFFFF
  classDef gate fill:#FFFFFF,stroke:#2F6BF2,stroke-width:3px,color:#2F6BF2
  classDef endpoint fill:none,stroke:#8A94A6,color:#8A94A6
  class fix,review,test step
  class approve gate
  class start,done endpoint
```

![The Playbooks panel showing a running Docs check playbook as a graph](assets/panel.png)

The panel next to the Playbook Manager's conversation, while a step runs:

![The Playbooks panel beside the Playbook Manager conversation](assets/app.png)

How the Playbook Manager drives steps, human gates and nested playbooks:

![Architecture diagram: the Playbook Manager agent starts each step of a Capability playbook made of a PR playbook and a Release playbook, with a human gate between them](assets/diagram.png)

## Layout

| Path | Contents |
| --- | --- |
| `index.server.ts`, `server/` | Daemon side: YAML loader and validator, run engine, run store, agent tools, hooks, RPC handlers |
| `index.client.tsx`, `client/` | The Playbooks panel (graph, node sheet, Start form), header button, and the sidebar entry with its all-workspaces screen |
| `shared/` | Zod types, RPC contracts, graph and template helpers |
| `examples/.paseo/plugins/playbooks/` | Example playbooks (PR, Release to dev, and Capability, which combines them as sub-playbooks) and their roles (not loaded by the plugin) |
| `.paseo/plugins/playbooks/` | This repository's own Docs check playbook (`docs.yaml`), which checks its docs, and its roles |
| `examples/.paseo/plugins/playbooks/sidekick/` | A starter Sidekick (`sidekick.yaml`, `instructions.md`) |
| `skills/paseo-playbooks/SKILL.md` | Agent skill for writing playbooks; copy or symlink it into a repo's `.agents/skills/` or `.claude/skills/` |

## The Sidekick

The Playbooks screen has a **Sidekick** button that opens a chat column on its right, with one tab per project
that has active runs or a Sidekick, and a **+** tab to add another project. A project's Sidekick is a
coordinator agent defined by a `sidekick/` folder beside its playbooks (`sidekick/sidekick.yaml` for provider,
model, mode, thinking and the events it `watch`es; `sidekick/instructions.md` for the repository's rules). It
runs in a hidden background workspace on the project root, watches the project's runs, judges which decisions
could be automated, and sends subagents to change the playbooks in pull requests that you merge. Its prompt
forbids it to edit files or run commands itself. A project without the folder shows a short tutorial and a button that writes
starter files. The `sidekick/` folder is not a playbook, so a playbook named `sidekick` still works.

A Sidekick may also live in `profiles/<id>/sidekick/`. Only active profiles participate; the first
alphabetically wins, ahead of the top-level folder, with warnings for ignored folders. Use
`sidekick: { tier: worker, subagents: { tier: worker } }` to resolve targets from the containing
repository/profile's `defaults/main.yaml`. Multi-entry tiers cannot have inline agent overrides.
Profile `agent_rules` apply to the Sidekick and its subagent briefs. The Sidekick skips targets at
the configured provider usage threshold and, on quota failure, moves through its tier followed by
`providers.fallback`, preserving its saved ledger and archiving the old agent first. Exhaustion is
remembered for `providers.exhausted_for` until plugin reload. Restarts and compaction replacements
use the same selection. When every target is exhausted, the failed agent remains visible without
an automatic retry. Subagent fallback is instructed through the Sidekick's prompt; the plugin does
not automatically replace those subagents.

The Sidekick is long-lived and found by its labels: `playbooks/sidekick` and `playbooks/project=<project id>`
(`paseo ls -g` lists them), so any agent can send it a prompt. It relays the human's answers to managers
(`send_agent_prompt`, `respond_to_permission`) and checks the gate moved, and creates its subagents on
`sidekick.subagents` (`provider`, `model`; default `claude` / `claude-sonnet-5-5`; optional `mode`, a Paseo
mode id such as `default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`, set on every subagent; unset, they
inherit the Sidekick's own `sidekick.mode`, and if that is unset too the plugin sends none and Paseo's default mode
for the provider applies; a value that is not a mode id is ignored with a warning); their finish notices wait
until it is idle. It can answer an open human gate of its project with `resume_gate` (also available to any agent outside the runs; set `gates: { on_behalf: deny }` in `defaults/main.yaml` to turn it off), only with the human's own answer given through its question tool; `gate.decided` shows `decidedBy: "agent <name> on behalf of the human"`. It saves a short decision ledger with `sidekick_handoff`. When its context passes
`sidekick.session.compact_above_tokens` (default 300000; its older name `restart_above_tokens` still works) its own conversation is compacted (`/compact`, sent while it is idle, with the ledger in the instructions and repeated to it afterwards): it stays the same agent, tab and chat, and the column shows "Compacting…". Only if compaction fails, or leaves it above `session.hard_limit_tokens` (default 1.5× the threshold), is it replaced by a new agent from the ledger, the old one archived first. A project never has two live Sidekicks (duplicates found at startup are archived).

The chat opens on the last 40 entries and reads 40 older ones each time you scroll near the top ("Loading older…", then "Start of the conversation"); your place is kept, and the view only follows new text while you are at the bottom.

A subagent that needs a place of its own gets a new hidden worktree workspace (the Sidekick creates it first with
`create_workspace { isolation: worktree, background: true }`; it never calls `create_agent` without a `workspaceId`,
which would put the subagent in the project's own checkout). Once such a subagent has finished and the Sidekick was told,
the plugin archives the subagent and its workspace after a grace period (`sidekick.subagents.archive_after`, default
`10m`; `sidekick.subagents.archive_workspace: false` turns it off). It only ever archives a hidden worktree workspace
that is not the project's root checkout, not a run's workspace and not the Sidekick's own, with no other agent in it,
nothing running or waiting on a permission, no uncommitted changes and no commits that are not pushed; otherwise it
keeps the workspace and logs why. The pending archives are saved and survive a restart.

Every ready agent step starts by itself: as soon as a step becomes ready (after a predecessor, a script, a gate, a loop-back or
a fan-in; also the steps of an after-task) the plugin starts it with its rendered prompt and inputs and an empty brief, with
the same model, role and workspace resolution as `start_step`. `start_playbook`'s `autoStart: false` keeps the steps ready at
the start in the manager's hands (later steps start by themselves). A step that needs a brief from the manager opts out with
`manage: { auto_start: false }`: it stays `ready` and the manager is woken to start it with `start_step`. `start_step` on a
step already running is refused (never started twice). The manager is woken only for what it must decide or what went wrong:
a reported step, a failure, a gate, a step waiting for a brief, a stall, the end of the run. A step that completes normally and
whose next step starts by itself stays in the run log; `manage: { notify: true }` wakes the manager for that step too. Both go in a step's
`manage:` block or in `manage:` of `defaults/main.yaml`. See `docs/adrs/2026-11-13-autostart-ready-agent-steps.md`.

A script step's sheet in the run graph shows whether a check is **running now** or the step is **waiting** ("next
check in ~30 s"), the running check's output (refreshed about every 2 s) and the last five checks with their
outcome and exit code. The output is kept in memory only (the last 4000 characters per check, gone when the step
ends or the daemon restarts, after which the run's recorded last-check output is shown) and is not redacted:
anyone who can see the panel sees what the script prints. Each check says what started it: the first run, the poll,
or an event ("woken by job.settled").

A script step can also wake on events: `script: { run: check.sh, poll: 10m, wake_on: [{ types: [job.advanced, job.settled],
filter: { playbook: other_pipeline, stage: production } }] }` runs a check at once when a matching event is emitted
(`types` take globs; `filter` matches payload fields by equality), and `poll` stays as the safety net (required). Events
during a running check cause one more check after it, never two at once; checks are at least 5 s apart; a step is not woken
by events about itself. See `examples/.paseo/plugins/playbooks/wait_for_upstream.yaml` and
`docs/adrs/2026-11-12-script-wake-on.md`.

### Admission on a stage's queue

A stage of a singleton pipeline can decide, per waiting job, who may join its next batch, with a script the plugin
runs itself (no batch, no manager, no agent):

```yaml
  - id: staging
    needs: [dev]
    playbook: { name: train }
    queue:
      mode: fifo
      admit:
        script: admit_staging.sh
        poll: 10m                       # required: the safety net
        wake_on:                        # optional; a new job of this queue always wakes it
          - { types: [job.advanced, job.settled], filter: { playbook: qa_pipeline, stage: smoke } }
```

The script runs in the pipeline's workspace and reads `PLAYBOOK_JOBS` (the stage's waiting jobs: `id`, `label`,
`since` and all their `inputs`), `PLAYBOOK_STAGE` and `PLAYBOOK_PIPELINE`. Its last stdout line is JSON:
`{"admit": ["job_a"], "hold": {"job_b": "QA not passed"}, "escalate": {"job_c": "dependency failed"}}`. A job it does
not name is held ("not admitted by the script"); exit 75 or a failure changes nothing (a failure shows as an alert on
the stage). A held job never blocks the others, and the panel shows each one's "Held" badge with the reason, since
when it waits and the last check. `escalate` also asks a human in "Needs you": check again, withdraw the job, or admit it
anyway. `job.held`, `job.admitted` (`via: script | human`) and `job.escalated` are public events. See
`examples/.paseo/plugins/playbooks/staged_release.yaml` and `docs/adrs/2026-11-12-event-core-queue-admission.md`.

The Sidekick can start playbook runs with `start_playbook` (a playbook with `isolation: { mode: worktree }` starts in the caller's workspace, or in `workspaceId`, in the run's private worktree, so several runs share one workspace and show in its Playbook panel; `newWorkspace: true` forces a new one. Any other playbook always starts in a NEW workspace: `workspaceId` then only names the workspace it is branched off, `workspaceName` titles it, and `newWorkspace: false` is refused. A Sidekick has no workspace of its own: it gets a new workspace, branched off its project's root, unless it passes `workspaceId` for an isolated playbook), and `list_playbooks` shows what is on offer. When you ask
it to merge a pull request, it starts the project's merging playbook (for example `pr-to-prod`), whose manager
merges; the Sidekick itself never merges. For bulk work ("do all tickets of project XYZ") it creates a coordinator
subagent that lists the tickets with its own MCP tools (the Sidekick has none) and starts one run per ticket.
`sidekick.runs: { max_concurrent, confirm_bulk }` sets limits: `max_concurrent` (unset: unlimited) is how many runs
of the project may be active at once, and `confirm_bulk: true` (default `false`) makes it ask you before launching
more than one run in a batch. Both are rules in its prompt, not enforced by the plugin.

You can paste or drop images and files (web) in the Sidekick's message box (up to 8 per message; images 5 MB,
other files 10 MB, 25 MB in total; executables are refused). Each shows as a removable chip, with a thumbnail
for images. Images reach the agent as image content blocks, the way Paseo's own composer sends them. Other
files are saved on the host under the system temp folder (`paseo-playbooks-attachments/`, kept a week) and
their paths are added to the message.

While the Sidekick works, **Enter** sends the message into the running turn (steering it). **Cmd+Enter**
(Ctrl+Enter elsewhere) or the **Queue** button holds it instead: it shows as a pending line above the box, with
an x to cancel, and is sent when the turn ends. When the Sidekick is idle, Cmd+Enter just sends. The queue is
kept by the column (per project, this session only), not by the daemon.

## Usage log

Every agent turn that ends adds one JSON line to `$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/usage/usage-YYYY-MM.jsonl`
(monthly files, UTC month of the row; append-only, never rewritten or deleted by the plugin; about 250 bytes a turn, roughly
1 MB a day on a busy daemon; the startup logs the total size at debug level). It exists to simulate moving roles to cheaper
models. Only counters and identifiers are written, never a prompt, message or tool output.

A turn row: `v` (1), `ts`, `agentId`, `turnSeq` (the agent's turn count), `runId`, `playbook`, `step`, `attempt` (the
attempt's `n`, steps only), `role`, `tier`, `provider`, `model` (as run), `kind` (`step`, `decider`, `manager`, `sidekick`,
`other`), `delta` (`{ input, cacheRead, cacheWrite, output }`: what the turn added, a restarted counter starts over),
`contextUsed`, `costUsd` (null unless the daemon reports a cost) and `retry`. Agents outside the runs have the fields they
have; `runId` and the rest are `null`. `cacheWrite` is always `null` (the daemon does not expose it), and coordinators and
interactive agents are not told apart: they are `other`.

`retry` is `recheck` (the attempt came from a goto with a delay), `feedback` (from a goto), `interrupted` (a further attempt of a
step without a goto: after a failure, timeout or lost agent) or `null` (a first attempt, and every other kind). When an attempt
ends a separate row `{ v, type: "attempt_end", ts, agentId, runId, step, attempt, outcome }` is appended (a line is never edited;
a reopened attempt can end twice, the last row wins): join it with the turn rows on `runId`, `step`, `attempt`. `tier` is the
tier an agent step or manager was resolved from (`agent: { tier }`, the defaults' `agent` and `manager`), also kept in the run
(`attempt.tier`, `managerTier`); after a move to a fallback target or the manager's model it stays the origin's, the actual
model is `provider/model`. Gate deciders have no tier. `readUsageLog(dir, { from, to })` in `server/usage-log.ts` streams the rows.
Decision: `docs/adrs/2026-11-24-usage-log.md`.

## Panel languages

The panel follows the Paseo app language: English, French (`fr`) and Simplified Chinese
(`zh-CN`), with English as the fallback for any other language or any string not yet
translated. The messages live in `client/i18n.ts`, with one fragment per area in `client/i18n-*.ts`
(`defineTranslations` from `@getpaseo/plugin`).
Everything the panel shows is translated: run cards and statuses, the graph and stages, the run
tabs and step sheet, gates and loop limits, analytics, the Burn rate limiting tab, the Sidekick,
profiles, buttons, empty states, errors and accessibility labels, with plural forms and
language-aware dates and numbers. A new user-facing string goes into all three languages in the
same pull request. Playbook text written by authors is shown as written. See
`docs/adrs/2026-11-20-panel-ui-translations.md`.

## Colours

A colour that carries a meaning is fixed, whatever the Paseo theme: running blue, waiting (needs you) orange, done green,
failed red, paused violet (a run that is paused by hand or on hold: its tab, its dot, its batch card and its "held" or "paused" tag in the Burn rate limiting tab). Only the light or dark shade follows the theme. Text, backgrounds, borders and buttons keep the
theme's colours. The values live in `client/semantic-colors.ts`; see `docs/adrs/2026-11-23-semantic-colors-fixed.md`.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Install on a local daemon from a stable checkout (not a Paseo worktree, which can be
archived), then reload after each change:

```bash
paseo plugin install "$PWD"
paseo plugin reload paseo-playbooks
paseo plugin logs paseo-playbooks
```

### Event log and job events

Run state is still one JSON file per run. Next to it, a pipeline (a singleton's run) and its batches keep an
append-only **event log**, `<run id>.events.jsonl`, in the plugin's `runs/` folder: one line per fact about its jobs
(`job.queued`, `job.joined`, `job.advanced`, ...), the first step of the event core (ADR
`docs/adrs/2026-11-12-event-core.md`). In this version the log changes nothing: the run file stays the source of truth,
and the log is checked against it. Two settings in the user config
(`$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/config.yaml`, read when the plugin starts, so reload after editing):

```yaml
event_core:
  log: true        # false: write no log and check nothing (the way back; state is the same either way)
  parity: warn     # warn: log a line when the log's reducers and the run state disagree; off: no check
```

The pipeline's jobs are also announced on the event bus, for `subscribe_events` and `list_events`:
`job.queued` (waits at a stage: handed off, or unlocked by a passed stage; one event per stage),
`job.joined`, `job.advanced` (passed a stage), `job.requeued` (back at its stage: its batch failed with retries left, `cause: batch_failed`, or a step's outcome the playbook declares `settle.effects: { <outcome>: requeue }` set it aside, `cause: outcome`, with `reason` and `blocker`),  `job.reopened` (`requeue_job` put a failed or non-success settled job back, with `previousStatus`, `previousOutcome`; `job.queued` with `via: reopened` follows), `job.followup_pending` (a batch ended while a detached job it settled with an outcome has no follow-up recorded) and `job.followup` (`record_followup`, or `start_playbook` with `forJob`, recorded one: `followUpRunId`, `note`), `job.settled`
(left with an outcome), `job.failed`, `job.withdrawn`, and, for a stage with `queue.admit`, `job.held`, `job.admitted`
and `job.escalated`. Payload: `runId` (the pipeline), `playbook` (the singleton's id),
`jobId`, `label`, `stage`, `batchRunId`, `outcome`, plus `via`, `nextStages`, `rides`/`retries`, `summary` or `reason`
per type. `filter` matches them by equality, e.g. `{ playbook: "release_trains", stage: "stg" }`. Deprecated until 2027-02-12 (ADR 2026-11-12-stage-batch-rename): `station`/`trainRunId`/`nextStations` are sent next to `stage`/`batchRunId`/`nextStages`, `job.boarded` next to `job.joined`, `PLAYBOOK_STATION` next to `PLAYBOOK_STAGE`, and `riding`/`stations` next to `batches`/`stages` in the tools' output.

### Rate limits

Off by default. The plugin paces playbook work against each provider's quota, so **how much runs at once is the result of the quota
left, not a setting**. Set it in a repository's or profile's `defaults/main.yaml` (the file where a playbook's defaults live), in the user config
(`$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/config.yaml`, applied without a reload), or both. Precedence, field by field: the folder's
`defaults/main.yaml`, then the user config, then the built-in defaults (the order `manager_recovery` and the other defaults follow). It is resolved **per run**
from the run's own playbook folder: a run is paced by its own `usable_percent` and `pacing`, while the quota readings, reservations and queue stay global per provider; each
run is gated by the `steps` and `playbooks` caps of its own resolved config, counting all runs. A change to `defaults/main.yaml` applies to the runs started after it, like the other defaults.
ADRs `docs/adrs/2026-11-23-quota-limits-in-defaults.md`, `docs/adrs/2026-11-20-rate-limiting.md` and `docs/adrs/2026-11-20-dynamic-rate-limits.md` and `docs/adrs/2026-11-21-pause-admitted-runs-to-fit-pace.md`; the former `rate_limits.mode` was removed, see `docs/adrs/2026-11-21-remove-rate-limit-mode.md`; a config that still sets it loads, the key is ignored and noted once in the log):

```yaml
quota_limits:
  quota:
    pacing: true           # (turned on by usable_percent alone) work starts only while the quota headroom covers its estimated cost
    usable_percent: 97     # a 100 h window then allows 0.97 points an hour (what is allowed so far); 97 is also the hard cap
    refresh_interval: 5m   # a reading younger than this is used as is
    max_age: 30m           # an older reading holds new work ("waiting for quota data") until a refresh succeeds
    gate_release_after: 10m # a run waiting at an open gate frees its reservation after this (a deferred gate: at once); 0 = at once, off = never
  steps: 4                 # optional hard cap: agent and script steps running at once, across all projects
  playbooks: 2             # optional hard cap: runs admitted at once
```

```yaml
closed_hours:                  # top level of defaults/main.yaml (or config.yaml), next to quota_limits and warden
  timezone: Europe/Paris       # IANA zone; default: the host's timezone
  slots:
    - { days: [saturday, sunday], from: "00:00", to: "24:00" }   # days: a name, a list, or weekdays / weekend / everyday
    - { days: monday, from: "00:00", to: "08:00" }               # HH:MM, to after from; 24:00 = end of the day; no wrapping past midnight
    - days: [tuesday, wednesday, thursday, friday]               # or several ranges for the same days (not mixed with from/to)
      slots:
        - { from: "00:00", to: "08:00" }
        - { from: "20:00", to: "24:00" }
```

A slot is either flat (`days` + `from` + `to`) or nested (`days` + a non-empty `slots` list of `{ from, to }` ranges), never both. Every range is validated like a flat slot, and overlapping or adjacent ranges (also across slots) are merged, so an hour is never counted twice. See `docs/adrs/2026-11-23-closed-hours-several-ranges.md`.

**Closed hours** (`closed_hours`, shared by the quota and the warden; ADRs `docs/adrs/2026-11-23-quota-closed-hours.md` and `docs/adrs/2026-11-23-closed-hours-shared.md`; `quota_limits.quota.closed_hours`, where it first shipped, still works and the top-level block wins): ADR `docs/adrs/2026-11-23-quota-closed-hours.md`): a provider's weekly window may reset on a weekday afternoon, so nights and weekends inside it would accrue allowance nobody can use. Declared slots are left out of both the time elapsed and the length of the window: allowed so far = Max usable quota × (open hours elapsed ÷ open hours in the window), never above Max usable quota, flat while a slot is closed. Slots are wall-clock times of the zone (a daylight-saving day is 23 or 25 hours); a window with no open hour falls back to the plain rule and the Burn rate limiting tab says so. Nothing else changes: runs are not paused or held because a slot is closed, exempt runs and holds behave as before, and the exhausted-window rule is unchanged. The **warden** pauses its clocks during closed hours: the time thresholds of `stale_definition`, `slow`, `gate_open`, `stalled` and `held`, and of the PR checks `pr_review_stale`, `pr_draft_idle` and `run_failed`'s window, count open time only (as held time is already left out), so nothing fires from time spent closed and a clock resumes when the slot ends. The Quota tab shows `Closed hours: Sat-Sun, Mon 00:00-08:00 (Europe/Paris)` under the project and a line while the allowance is frozen; the read-only **Off hours** tab (ADRs `docs/adrs/2026-11-23-off-hours-tab.md` and `docs/adrs/2026-11-23-off-hours-by-project.md`) lists the projects like the Quota tab; opened, each shows whether a slot is closed now, the next open or close time, the weekly schedule, a week planner and what a closed slot does. `validate_playbooks` refuses an unknown day, a bad time, `from` not before `to` and an unknown timezone.

**Headroom** of a provider window = what is allowed so far (`usable_percent` × elapsed / window length, the tightest window winning)
minus current usage minus what work already started still has to use. Work starts while the headroom covers its **estimated cost**: the
quota points the playbook's remaining agent steps will use: each step's expected duration × the playbook's **burn rate** (quota points per hour of active agent time), else the average points a step used, all measured from the usage readings and kept in `rate-history.json` (see "Quota per hour" below; there is no manual estimate;
`quota_limit.estimate` was removed and is refused at load). A playbook with no history is **not paced by cost** (it starts
without a headroom check and reserves nothing) until its first measure exists; the hard cap (`usable_percent`) and "waiting for quota data" still hold it.
A playbook whose estimate is **zero** (at most 0.05 points) is treated the same: it can't move the pace, so it is never held for headroom, never paused to fit the pace, reserves nothing and isn't blocked behind a held higher-priority run; an exhausted window or unavailable data still hold it.
The rest is held; the plugin lifts the hold itself.

- A run is admitted only when the headroom covers its whole estimated cost. The capacity is dynamic over
  running runs too: when the pace no longer allows as many runs as are running (say it allows 4 while 10 run), the extra ones are
  **paused** when they reach the end of a step (a running step is never interrupted). Those that keep running are chosen by priority, then
  oldest first; the lowest priority and newest are paused. Paused runs resume one by one, in the same order, when the pace relaxes or a
  continuing run finishes; the capacity is re-checked each time, so never more runs than it allows progress. Runs with no measured cost
  (or a zero one, at most 0.05 points) are not paced and never paused. An admitted run's remaining cost is **recomputed from the current history at every check** (per-step cost × its remaining agent steps, minus what its running steps already used), so a run admitted before its playbook had any history becomes pace-able, and can be paused at its next step boundary, as soon as a measure exists; it then shows in the Burn rate limiting tab's Reservations with that figure. Held and paused runs are re-checked at once when a run ends or is archived or a step ends (debounced, one check per burst), with the 15 s timer as fallback. A run is also held between steps when its quota is exhausted (a window at `usable_percent`).
- **Priority**: `quota_limit: { priority: 0 }` on a playbook (or in `defaults/main.yaml`), overridden per run by `start_playbook`'s `priority`.
  Higher goes first, ties oldest first, also for the optional caps. A held run blocks lower ones on the same provider, so a large run is not starved.
- **Burn rate** (ADR `docs/adrs/2026-11-24-quota-per-hour.md`, named by `docs/adrs/2026-11-24-burn-rate-naming-and-reset.md`; not to be confused with the *Burn rate limiting* feature, which is the whole quota pacing, nor with *Quota per run*, *Throttle* or *Allowed so far*): the history also keeps, per playbook, provider and quota window, the **agent time** that produced the points, so the **burn rate** is quota points (percent of the window) per hour of active agent time, shown as `0.6%/h`. What is summed: for each finished agent step attempt, its overlap with the usage readings that measured its points (`startedAt` to `endedAt`, agent steps only; no gate, script or waiting time between steps; the time a step's agent spends waiting inside the attempt does count). Concurrent attempts each count their own time and share the points of the interval by it, so the rate is per agent hour. The mean duration of a finished attempt is kept per playbook step. A run's remaining need for a window is the sum over its remaining agent steps of **expected duration × burn rate** (a running step: what is left of its expected duration, never below 0; its measured use is then not deducted again); for a step with no known duration, or while less than 1 minute of agent time backs the rate (or the history predates agent time), the **average points per step** (the previous rule). Each step counts once, from one source. Zero-cost, exempt-run, returning-run and gate rules are unchanged. Limitation: a step that loops (a babysit re-check up to `max_loops`) is counted once; repeated passes are not modelled. `get_analytics` (and the Analytics tab, "Burn rate" card) returns `quotaRates` per playbook and provider window: `burnRate` (percent points per active agent hour), `pointsPerStep`, `quotaPerRun` (quota per attempt × agent attempts per finished run in the range), `steps`, `agentMs` and `lowConfidence` (under 5 finished attempts or 10 minutes of agent time); it is the all-time history, not narrowed by the range. In the **Burn rate limiting** tab, each project lists its playbooks' burn rate (an (i) gives the formula) and a Reservations row reads `weekly: ~0.3% (about 25m at 0.7%/h)` when its need comes from durations. **Reset**: a *Reset* button per playbook (and per step, under "Steps") erases the learned data after an inline confirmation (RPC `quota.reset_burn_rate { playbook, step? }`, panel only, no agent tool; event `quota.burn_rate_reset { playbook, step, erased: { entries, steps, ms }, by }`). A playbook reset deletes every learned cost row of the playbook (all providers and windows: points, steps, agent time) and all its step durations; a step reset clears only that step's learned duration (the points are learned per playbook, so they stay and the step is priced by the average cost of a step until measured again). After a playbook reset the playbook has no history and is not paced by cost until measured again; admitted runs lose their need at once and held runs of it are released at the next check. The last reset time is kept (`@resets` in `rate-history.json`) and shown as `reset <date>`.
- **Exempt runs**: `start_playbook { ..., quota: { exempt: true } }` starts a run that is **not subject to burn rate limiting** (meant for work that must not wait, e.g. a request from a human in a chat). It is never held or paused for quota: not for headroom, not for the pace, not for an exhausted or unavailable usage window, and the `steps` / `playbooks` caps do not apply to it (its running steps still count in the "running now" figures). It still **reserves** its estimated cost (its remaining need once running), so the headroom the other runs see shrinks by it and paced work yields to it; it is no waiter of the queue, so it blocks no lower-priority run, and it gets no hold notice. Its measured cost is recorded in the history as usual. The flag is set at start (it can be changed later: see the exempt toggle below), **inherited by its child runs** (fan-out, pool, `replace_child`) and kept by `restart_run`; `get_run` and `list_runs` show `quotaExempt`, the run's history says `quota: exempt`, the Runs view shows an `exempt` tag where the priority control would be, and the Burn rate limiting tab tags it `exempt` among the reservations. Any agent that may call `start_playbook` may set it (no config switch): see `docs/adrs/2026-11-23-quota-exempt-runs.md` for the risk.
- **Reset tool** (`reset_burn_rate { playbook?, step?, all? }`, also the panel's Reset buttons and `quota.reset_burn_rate { all: true }`; callable by managers and the Sidekick, not by step agents; ADR `docs/adrs/2026-11-24-burn-rate-naming-and-reset.md`): a HARD reset that deletes learned data. Give exactly one of `playbook` (erases its learned cost rows and step durations), `playbook` + `step` (that step's duration only) or `all: true` (every playbook of the history, one `quota.burn_rate_reset` event each; the result counts entries, attempts and agent time erased per playbook). Runs are unpaced until measured again; held runs are released at once. The Burn rate limiting tab has a *Reset all* link with an inline confirmation.
- **Exempt toggle** (`set_run_quota_exempt { runId, exempt, applyToChildren? }`, also the `runs.set_exempt` RPC behind the emergency button of the Runs view's priority menu; callable by any non-step agent, like `set_run_priority`): exempts a running, queued or held run from burn rate limiting (`exempt: true`) or puts it back under the limits (`false`). Exempt: any quota, headroom, pace or cap hold is lifted at once (the pace plan is read again and the ready steps start without waiting for the 15 s tick), it gets no hold notice and keeps reserving its cost for the others, like a run started exempt. Not exempt: the limits apply again from its next step; a running step is never interrupted. `applyToChildren` is a sticky flag (`inheritChildExempt`, independent of the priority's): `true` copies the state onto every active descendant now (cycle and depth safe) and later changes follow; `false` stops following without resetting the children; omitted keeps it. Idempotent; refused on a finished or archived run. The history records `quota_exempt_changed` (from → to, who) and `run.quota_exempt_changed` is emitted (from, to, inheritChildren, cascaded, by). In the Runs view the priority menu has a "Run now, ignore burn rate limits" button (two taps: the second confirms) and, once exempt, "Back under burn rate limits"; the row shows the `exempt` tag, which opens the menu. **Any agent can exempt its own run**: it is allowed but visible in the history and the event. See `docs/adrs/2026-11-23-run-quota-exempt-toggle.md`.
- **Dismissed review findings** (`dismiss_finding { runId, pr, file, text, severity, category, rationale }`, `list_dismissed_findings { pr, file?, text? }`; non-step agents). For a review loop in which a code-review bot re-raises the same findings on every head: the manager dismisses a finding with a written rationale and the plugin records it on the run (`get_run` `dismissedFindings`, history `finding_dismissed`, event `finding.dismissed`), keyed per PR by a **signature** (`fs1:` + 16 hex of SHA-256 of `<file>\n<normalised text>`: case, markdown, severity badges, line numbers and punctuation do not count; not the comment id or the head). Refused in code, left to a human: P0/P1 (critical, blocker, high, major), an unknown severity, a missing severity or category, and categories security, auth, secrets, credentials, IAM, migration. Idempotent. It **posts nothing**: replying on the PR thread stays with the caller. A project's check script calls `list_dismissed_findings { pr, file, text }` for each finding the bot raised and skips those with `dismissed: true` (without `file`/`text` it lists the PR's dismissals from every run). No setting. See `docs/adrs/2026-11-23-dismiss-finding.md`.
- **Old names**: `rate_limits` (config or defaults) and `rate_limit` (playbook or defaults) still work as deprecated aliases and log a one-time note naming the new key; when both are set, the new key wins. Only the config keys were renamed: `rateHold`, `run.held`, `run.released` and `rate-history.json` are unchanged.
- **Gates free the headroom** (three rules). A run is *waiting* when it has no running, ready, queued or reported step, no running after-task, and every open gate waits for a human (a fan-out waiting for its children is not waiting). (1) If all its open gates are **deferred** (Waiting), it releases its quota reservation **at once**. (2) With an ordinary open gate it keeps it for `quota.gate_release_after` (default `10m`; `0` = at once; `off` = never, deferred gates included), then releases it; a gate returned to review restarts that grace. (3) When the gate is **decided or returned** the reservation is rebuilt at that moment, and a returning run goes **before runs that never started** at the same priority (a higher manual or playbook priority still wins), for 15 minutes; it is paused like any admitted run if it no longer fits (a normal hold, the gate stays decided). A human pause and the `playbooks` cap are unchanged; exempt runs release too. See `docs/adrs/2026-11-24-gate-waiting-releases-reservation.md` and `docs/adrs/2026-11-24-deferred-releases-now-returning-first.md`.
- To pace at 90% for a profile, put `quota_limits: { quota: { usable_percent: 90 } }` in its `defaults/main.yaml`.
- The **Burn rate limiting** tab (Runs, Analytics, Burn rate limiting, Profiles) has one collapsible row per project, under a line with the steps running and active runs (the caps count those over all projects). A collapsed row shows a state dot (green: room, amber: usage unavailable or no room, red: over what is allowed so far, grey: max usable quota off), the project's **Max usable quota** (its `usable_percent`, e.g. `Max usable quota 90%`, or `Max usable quota off`), the state of each provider for it (e.g. `claude 12% free`, `claude 3% over the allowance`, `codex over the allowance`), the word `throttled` when new work with a real cost is held for a provider, and its step and run caps. The two figures are named apart: **Max usable quota** is the setting (`usable_percent`); **Allowed so far** is the value that rises with time through the window: Max usable quota × the share of the window already elapsed (a 100 h window at 90% allows 0.9 points an hour), never above Max usable quota. The limits are those a new run of the project gets (the project's main checkout's `defaults/main.yaml`, with isolated playbooks read from their base on origin, then `config.yaml`, then the built-in ones). An opened row has, per provider and usage window, a bar and the numbers: for a project that paces, grey is the usage up to what is allowed so far (`usable_percent` scaled to the time elapsed), blue the reservations of admitted and queued runs (right after the usage; the word "Reserved" and its figure are blue too), green the room still free (headroom minus the reservations of admitted and queued runs), red the usage above what is allowed so far, a tick marks it; for a project with max usable quota off, or a model window, a plain grey bar and "no allowed so far". Each provider also has a **Throttle** line (a violet bar, as for on-hold, and a number): `1 − free headroom ÷ typical run need`, clamped to 0–100%, where the free headroom is the window's allowed so far minus usage minus every reservation (the tightest paced window wins) and the typical need is the median remaining need of the project's runs admitted or queued on the provider (a held run counts with its estimated cost), else the largest measured cost of one step of the project's playbooks. 100% means new work with a real cost is held; 0% means the free headroom covers a typical run; "no estimate" when no measured cost exists (zero-cost runs and runs with no history are never throttled). The line under it counts `N held · N paused · longest wait Xh Ym · next retry HH:MM` from the runs' `rateHold` (nothing new is stored). It also shows the reset and last-read times, the project's reservations (a run held or paused by rate limiting is listed there with a short "held" or "paused" tag) and the exhausted marks. It refreshes every 30 s and with the header's refresh button. The runs' priorities are changed in the Runs view, not here. In the **Runs** view, every active run of a project that paces has a priority control at the right of its row (a list icon and the run's priority; fan-out children get it too): it opens a menu with a stepper and field plus "Apply" (nothing is sent until you apply), "Reset" (back to the playbook's priority), whether the priority is manual or the playbook's, and, for a run with children, an "Apply to children" checkbox (see **Run priority override** below); a manual override is shown in the accent colour. See `docs/adrs/2026-11-23-quota-limitation-tab.md`, `docs/adrs/2026-11-23-quota-limitation-per-project.md` and `docs/adrs/2026-11-23-quota-limitation-project-rows.md` and, for the wording and the throttle, `docs/adrs/2026-11-23-quota-wording-and-throttle.md`.
- A provider that reports no usage is not paced; the run carries a note (`rateNote` in `get_run`, shown in the run's menu) and the plugin logs it once.

A running step is never interrupted. `get_run` shows why in `rateHold` (kind `headroom`, `pace` (an admitted run paused to fit the pace, with its position in the resume queue), `quota`, `steps` or `playbooks`, reason, estimated cost,
headroom, position in the queue, priority, retry time), the manager and the Sidekick are told (`run.held`, `run.released`), and the run's tab
says "on hold" with a "Continue anyway" button for a quota or headroom hold (one hour, per provider).

**Provider usage unavailable.** Whether a provider's usage can be read is a condition of the provider, not of a run
(`docs/adrs/2026-11-23-provider-usage-unavailable.md`). It is derived from the pacing's readings (nothing new is stored on runs): a provider
is *unavailable* when the usage endpoint keeps failing and its last good reading is older than `quota_limit.max_age`. The Burn rate limiting
tab shows it once per provider, in violet and not as an error (`claude: Usage unavailable since 15:42 (HTTP 429) · last read 15:31`); under
each project the provider's last known windows are greyed and marked stale, and the allowed-so-far, headroom and throttle parts read
"unknown". The `quota.limitation` RPC carries it per provider in `usage` (`available`, `since` = first failure of the streak, `lastReadAt`,
`reason`, `failures`; an older panel ignores it). Two plugin events, on transitions only: `provider.usage_unavailable` (provider, since,
reason, failures, lastReadAt) and `provider.usage_restored` (provider, since, reason, unavailableMs); they carry no run, so they may be
subscribed unscoped. A run whose steps use an unavailable provider is still held (no fail-open), with the reason `waiting for quota data on
<provider>` and no per-run detail; its manager is **never** told of this hold (nor of its end), and a later real quota hold of the same run
still gets its one notice (`docs/adrs/2026-11-23-hold-notice-per-episode.md`). A switch of a run's hold between headroom and waiting for quota
data keeps one hold: no new `run.held`, no `run.released`, the hold keeps its start. The warden has no provider-level finding (its checks are
per run); the two events cover it.

### Profiles

A profile is an extra, opt-in repository of playbooks, with the same layout as the playbooks folder
(playbook files, `roles/`, `defaults/`, `scripts/`), in `.paseo/plugins/playbooks/profiles/<name>/`
(see `examples/.paseo/plugins/playbooks/profiles/personal/`). The folder itself is the `default`
repository, on unless a project turns it off in the same dropdown. Profiles are off by default and are turned on per project: in the "Profiles" tab of the
Playbooks screen (one row per project) or in the same dropdown at the top of a Playbooks panel. The choice
applies to every conversation of every workspace of the project, and is stored per user in
`$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/config.yaml` as
`profiles: { projects: { <project id>: { active: [louis], default: false } } }` (`default: false` only when default is
off; the old global `profiles.active` is ignored).
The profiles on offer are those of the project's main checkout. A profile's
playbooks are named `<profile>:<id>` (`louis:deploy`), and resolve their roles and sub-playbooks only
inside the profile. If two repositories share an id, both are kept, and a bare `deploy` is refused as
ambiguous: write `default:deploy` or `louis:deploy`.

To use playbooks in a repository, copy `examples/.paseo/plugins/playbooks/` into it (as
`.paseo/plugins/playbooks/`),
adjust the roles and playbooks and commit them. Then open the Playbooks panel in a workspace of
that repository and press Start. Start runs the playbook with the workspace's most
recently used agent as manager (see Known limits), in that workspace (the run starts at
once, but if that agent is busy, its kickoff waits until its current turn ends). The arrow
next to Start offers "Start on a new agent", which creates a new manager agent in the same
workspace, and "Start in a new workspace", which creates a new worktree and manager.

The panel's tab bar shows **Runs** only at first (it cannot be closed). The **+** button at the end of the bar lists the other tabs (Analytics, Burn rate limiting, Off hours, Profiles); picking one opens and selects it, its **x** (shown on hover or keyboard focus, always on mobile) closes it, and closing the selected tab returns to Runs. The added tabs are remembered across reloads (ADR `docs/adrs/2026-11-23-addable-panel-tabs.md`); everyone starts with Runs only after the update.

The overview screen lists one section per playbook (its runs inside). The **sort** button in the Runs tab (top right of the filter row, not in the other tabs),
orders those sections: **Name (A-Z)** (the default, so the order never jumps), **Last activity** (the playbook with the most
recently updated run first), **Status** (the playbook with a run waiting for you first, then working, paused, failed, done,
seen) or **Start time** (the playbook with the newest run first). The choice is kept by the host, so it survives reloads;
"Needs you" follows the same order. Playbooks never leave the list because of the sort, only their order changes (and, with
Last activity or Status, as runs change). The Runs sort inside each playbook is separate and unchanged.

**Waiting (deferred gates).** "Needs you" lists only the gates to decide now. On a Needs you row, **Defer…** sets a gate you
reviewed aside in **Waiting** with a required reason and what it waits for. The gate stays open and can still be decided
there (**Decide**), by the same rules; deferring is not an answer. What it waits for is *tracked* when it is a date, the end
of another run of the project, or the decision of another gate of the project: the gate then returns to Needs you by itself
(count, header dot, and a `gate.returned` event the Sidekick is told about). Anything else (a PR merge, a reply, a deploy)
is *manual*: the plugin cannot see it, the row says so, and it returns when you press **Bring back** (or the Sidekick
calls `return_gate`) or on an optional reminder date. The Sidekick can record a deferral with `defer_gate` at your request, or, as a rule it must follow, on its own judgment for a routine gate that
plainly cannot be decided yet and waits for something external (it may not leave it open with a promise to check later; it loads the
deferred tool with `ToolSearch` first, and says so if that fails) (recorded as its own, never as yours, and it tells you afterwards; secrets, credentials, IAM,
auth, data loss, billing and production gates stay with you), under the same scope as `resume_gate`; `list_gates` keeps listing deferred gates (`needsReview: false`, `deferral`). Tracking
reads run state only, never chat; there is no push or Slack notification. See `docs/adrs/2026-11-20-deferred-gates.md`.

The **Run Playbook** button in the header of the overview screen (the one with the tab bar,
next to Sidekick) opens a form to start any valid playbook of a project in a new workspace: a project dropdown
(preselected to the project chip selected on the screen; with "All projects" you choose one), a workspace name (optional; empty keeps the default title, the playbook title and the
request), a playbook dropdown, then that playbook's inputs. **Start**, at the bottom, creates the workspace and the run;
a failure shows in the form, a success as a toast ("Started <playbook> in <workspace>"); the screen stays where it was, the new run appears in the list, and the new workspace is not opened. The name is a title only (one line, at most 80 characters): the
branch is still `playbooks/<playbook>-<id>`. The same title is available to agents as `workspaceName` on
`start_playbook` with `newWorkspace`. A playbook can set the default title itself: `workspace: { title: "Ship {ticket}" }` (in the playbook or `defaults/main.yaml`, the playbook wins), with `{input}` filled from the run's inputs, also for fan-out children (their own inputs) and replacements. The title is, in order: the name passed (`workspaceName`, or typed in the form), `workspace.title`, then `<playbook title>: <first input>`. If a placeholder names an input the run does not have, or one that is empty, the template is skipped and the default title is used; the result is cut to one line of 80 characters. `validate_playbooks` rejects a playbook's `workspace.title` that names an input it does not declare (a template in `defaults/main.yaml` is not checked: it falls back at run time). See `docs/adrs/2026-11-23-workspace-title-template.md`. The button is shown when a project has a startable playbook (disabled while the
lists load). The per-workspace Playbooks tab has no such button: its cards offer "Start in a new workspace", which
has the same workspace name field.

Step agents (including managerless implementers and reviewers) receive the read-only
`validate_playbooks` tool alongside `report_step_result`. It defaults to the caller’s working
folder and resolves active profiles from the caller’s workspace project. An optional `path`
changes only the folder to inspect, so it does not select another project’s profiles. Check
that the returned results include the intended playbooks: an empty list is not a validation
pass for them. Step agents receive no additional manager controls.

## Release

The version lives in `package.json`, and `package-lock.json` must carry the same one. A pull
request that changes shipped files (`client/`, `server/`, `shared/`, `skills/`, `assets/`,
`index.*`, `paseo-plugin.json` or `OVERVIEW*.md`) must bump it, or CI fails; CI also fails when
the two files differ:

```bash
npm version patch --no-git-tag-version   # or minor / major
```

When a new version reaches `main`, the Release workflow tags it `vX.Y.Z` and creates a GitHub
release. To update the official listing on paseo.sh/plugins, run the `update-official-plugin`
skill (`.agents/skills/update-official-plugin/`): it opens a submission on `getpaseo/plugins`
with that tag.

## Known limits

- Reloading the plugin (`paseo plugin reload`) removes the playbook tools from agents that
  are already running. They get the tools back when their session restarts.
- If the daemon restarts before a busy agent's queued kickoff is delivered, the kickoff is
  lost (the queue is kept in memory only). After the restart the agent gets a short "carry
  on" note, but never got the manager instructions. If it does not pick the run up, cancel
  the run from the panel and start again.
- After a daemon restart, recovery starts at the plugin's first event (the app connecting, an
  agent opening a session), not when the daemon starts. A step's timeout keeps counting while
  the daemon is down.
- Live step timer: a running step shows `running for 45s` (`<1s`, `45s`, `12m`, `1h05m`) in its graph card and in its
  details sheet, for the current attempt, ticking every second from one shared clock (`client/now.tsx`). A step
  waiting on a pending gate shows none, and it disappears once the step is over.
- Slow-step warning: a step that takes more than `factor` (default 2) times the mean duration of its last `runs`
  (default 10, at least 3) completed runs of the same playbook and step gets a yellow triangle in the run's row on the
  Playbooks screen and on the step in the panel, with e.g. "12m, 3.1x the usual 4m". It needs 3 completed runs, ignores samples under 1s (steps that did not really run) and never warns under 10s;
  it is computed from the run history the panel has loaded (nothing is stored) and, once shown, stays on screen.
  Set `slow_warning: { runs, factor }` in a playbook or in `defaults/main.yaml` (the playbook's wins, field by field).
- Quota-blocked manager: when a run's manager is blocked by its provider's quota (`managerQuotaBlocked` in `get_run`) and the run is unfinished (with or without queued work: a manager that still has to route a step outcome has an empty inbox), the plugin retries the recovery by itself from its 15 s timer, with a per-run backoff (30 s doubling to 10 min) and the shared usage cache, so the endpoint is not hammered. A retry succeeds only when a target of the manager's chain has headroom in the provider's usage reading (or its `providers.exhausted_for` ended); then a new manager takes the run over, a `manager_recovered` history entry is written and `run.manager_recovered` is emitted. Opt-in `manager_recovery: { retry: true, fallback: { provider: codex, model: gpt-5-mini } }` (in `defaults/main.yaml`, a playbook or `config.yaml`; a playbook's wins, then the user config) sets `retry: false` to turn the automatic retry off, and `fallback` adds a provider/model the manager may be re-assigned to after its own chain (default: retry on, no fallback). `recover_manager` by hand works as before. See `docs/adrs/2026-11-23-manager-auto-recovery-and-fresh-workspaces.md`.
- Fresh new workspaces: a run started with `newWorkspace` begins in a workspace that is fetched and fast-forwarded (`git merge --ff-only`) to `origin/<branch>` of the root checkout's branch, so files added on origin are there; when that is impossible (offline, diverged) the run starts as it is and a note is logged. A script step whose file is missing from the workspace fails at once with the missing path and the workspace head sha instead of a bare `ENOENT`.
- Agent rules: `agent_rules: ["Prefer simple, separate shell commands."]` in `defaults/main.yaml` is a list of short
  house rules (at most 20, 500 characters each) put in the prompt of every agent of the folder's playbooks: the Playbook
  Manager (with its instructions), step role agents, after-task agents, role deciders and fan-out child managers. A
  playbook adds its own `agent_rules:` after the repository's; a rule written twice appears once; there is no opt-out.
  They show as a "Rules" section, apart from the playbook's prompts, which cannot override it. An agent keeps the prompt it
  started with: a changed list applies to agents started (or restarted) afterwards. See `docs/adrs/2026-11-18-agent-rules.md`.
- Times in `get_run` (both views): the run and each started step have `startedAt`, `endedAt` (ISO, absent while running)
  and `durationMs`; `live: true` marks a running one (the duration is the time so far). A retried step shows its current
  attempt and `totalMs` across attempts (full view: `attemptTimes`). Runs recorded without timestamps omit them.
- Slow steps for agents (same rule, `shared/slow.ts`, but on the server's whole run history): `get_run` shows
  `slow: { elapsedMs, baselineMs, factor, ratio, samples, running }` on a slow step and `slowSteps` on the run;
  `list_runs` rows have `slowSteps`, and `list_runs { slow: true }` lists only runs with a step that is slow right
  now; `subscribe_events` type `step.slow` fires once when a running step first goes past the threshold (checked
  every 30 s). See `docs/adrs/2026-11-12-slow-steps-in-tools.md`.
- Warden (`warden: { enabled: false, interval: 15m, cooldown: 1h, checks: { stale_definition: { after: 12h, action: report }, manager_blocked: { action: report }, loops: { above: 5, action: report }, slow: { action: report }, gate_open: { after: 30m, action: report }, stalled: { after: 30m, action: report }, held: { after: 2h, action: report } } }`, in `defaults/main.yaml` or a
  playbook): **off by default**; with no block, or `enabled: false`, nothing runs. When on, one deterministic pass (no LLM, no
  message to any run agent) looks at each active run every `interval` and finds: a run pinned to an older definition than
  `origin/<base>` (`stale_definition`, only once the run has held that pin for `after`, default `12h`: a healthy run a few commits behind is not reported, and the check does not look at which files changed; read from the workspace checkout is reported at once; its action may be `refresh_scripts`, isolated runs only, once per finding), a manager gone or
  idle while a gate it holds is open (`manager_blocked`), a goto edge that fired more than `above` times (`loops`), a running step
  slower than its baseline (`slow`, the `step.slow` data) and a gate open longer than `after` (`gate_open`, `gate.stale`'s age) and an active run that has had no running, ready, queued (or
  waiting) step and no open gate for longer than `after`, default `30m` (`stalled`: nothing will move it by itself; the finding gives the
  manager's state, such as quota-blocked (with the earliest time it can work again, or `unknown`, and the exhausted providers), and what the run last did; paused runs, pipelines and batches are skipped), and an active run
  held for quota (`rateHold`, not paused by a human) for longer than `after`, default `2h` (`held`: the finding gives the reason,
  provider and usage window, the run's queue position and priority, the held runs ahead of it, the estimated cost against the headroom
  and the retry time). A hold is expected and self-resolving, so no other check counts it: a held run is never `stalled` (its idle
  clock restarts at the release), `stale_definition` ages a pin without the time spent held, and `slow` only looks at running steps. The run's manager is told once per hold episode: when the run is first held for quota, whatever the kind, and never again for a change of reason, kind, provider, window or position, or a hold lifted and re-taken, until a step of the run starts again.
  `action` is `report` or `none` (`none` turns a check off). A finding is reported once (event `warden.finding`, for the first
  three; `slow` and `gate_open` reuse `step.slow` and `gate.stale`), shown in the run's panel and in `get_run`'s `warden`, and again
  only after `cooldown` if still true *and* it changed meaningfully: a count (`loops`) or an idle time (`stalled`) at least doubled since the
  last report, or the run's state changed (`stale_definition`: running/paused; `stalled`: the manager's state; `held`: the hold kind, its value being the hold minutes); `stale_definition` is never
  reported for a run that only waits on a gate. A running Sidekick gets one summary per pass with only the new findings. See
  `docs/adrs/2026-11-18-warden.md`.
- PR checks (`warden.pr_checks`, `defaults/main.yaml` only, each check off unless its block is set; needs `warden.enabled` and a project with a Sidekick): every `interval` one `gh pr list` read of the open PRs finds a PR with none of `no_reviewer.required` requested (`pr_no_reviewer`), `conflicting` (`pr_conflicting`), no `review_bot` receipt for its head after `review_stale.after` (`pr_review_stale`), a `required_checks.names` entry not run on its head (`pr_required_checks`), changes requested by the bot with no `fix_step` running (`pr_review_findings`), no owning run (`pr_unowned`: the run's branch is the PR's head, or the PR URL is in its state) or a draft idle for `draft_idle.after` (`pr_draft_idle`). Each finding carries the run id (if any), the PR, the cause and a proposed action (text: the warden takes none) and reaches the Sidekick in the same summary, deduplicated the same way. See `docs/adrs/2026-11-20-warden-pr-checks.md`. Extensions (`docs/adrs/2026-11-20-warden-pr-checks-extended.md`): `repos: { names: [owner/repo], from_runs: true }` scans several repositories with `gh pr list --repo` (default: the project root's), ownership matched per repo; `required_checks: { from_ruleset: true, workflows: { check: workflow } }` adds the checks the base branch's ruleset requires (`gh api repos/<repo>/rules/branches/<base>`; an API error is logged and skipped) and names the workflow (`{workflow}`, `{repo}` in `dispatch`); `review_findings: { marker: { pattern, truthy } }` reads the bot's own marker (`pattern` has one capture, `truthy` matches the captured value when findings are open) instead of CHANGES_REQUESTED; `failed_run: { playbooks: [ids], within: 24h }` proposes a failed run (or failed step) of those playbooks with the run id, step and error (`run_failed`).
- Manager watchdog (`manager: { nudge: { enabled: true, after: 3m, max_interval: 30m } }`, in `defaults/main.yaml` or a
  playbook's `manager:` block): a step that reported (an agent or script step, a success or a failure) and still waits for
  its manager after `after` gets ONE targeted prompt to the manager (run, step, outcome: complete or route it), then again after
  2x, 4x, ... `after`, capped at `max_interval`, for as long as it waits. Only an idle manager is prompted: never one running a
  turn, one with an open question or permission request, a paused or ended run, or a run with an open gate or ask held by a
  human or a role. The count survives a restart (it is in the run). After the second prompt without progress the plugin emits
  `step.waiting_manager_stuck`; a manager question or permission request open for `after` emits `manager.question_pending`
  (once per episode each). The Sidekick's default `watch` includes both. See `docs/adrs/2026-11-18-manager-waiting-watchdog.md`.
- After a plugin update, idle agents whose session holds the old plugin's tools are reloaded (history
  kept) so they stop failing with "Tool not found"; an agent mid-turn is reloaded when its turn ends,
  never one waiting on a permission or question. Turn off with `reload_stale_sessions: false` in
  `defaults/main.yaml`. Agents from before v0.51.0 are reloaded only if they belong to a run
  (see `docs/adrs/2026-11-09-reload-stale-sessions.md`). The reload runs in the background, four sessions at a time: hooks and the panel stay
  answered during an update (`docs/adrs/2026-11-18-non-blocking-hooks-and-reload.md`); its end is logged with its duration.
- A `tiers:` entry in `defaults/main.yaml` may be a list of providers: when a step agent runs out of tokens
  (quota, rate or usage limit, no credits), the same attempt restarts on the next entry, without using a
  retry, and the exhausted `provider/model` is skipped for `providers: { exhausted_for: 1h }` (default 1h; limits
  reset, so it is tried again after that; very short values re-probe a failing provider). Run state keeps
  `run.exhausted` as `{ target, at }`. Error texts are matched by pattern, so an unusual provider message
  may not be recognized and the failure then goes to the manager. With `providers: { on_exhausted: wait }`
  (default `fail`), when every entry is out of tokens the step keeps its place and its attempt restarts by
  itself once a provider is due again (no retry used); `max_wait: 12h` caps the wait, after which the failure
  goes to the manager (default: no cap). The panel shows "Waiting for tokens until HH:MM" on the step. A multi-entry tier cannot be combined
  with inline `provider`, `model`, `mode` or `thinking` on the same `agent` block. Each entry has its own
  `mode` and `thinking`. The run log gets a `provider_exhausted` line.
  The manager itself never switches mid-run (see `docs/adrs/2026-11-10-provider-fallback-tiers.md`).
- Usage-aware fallback: `providers: { usage: { check: true, threshold: 100 } }` (defaults; `check: false` disables).
  Before a step agent, gate decider or manager starts, the plugin reads the provider usage the daemon reports
  (`paseo usage`, per host, so every run sees it) and skips the tiers' targets whose provider has a usage window
  at or above the threshold, starting on the first one that is not. A window named for another model
  (`weekly_model_<x>`) is ignored for a target whose model does not contain `<x>`. If usage cannot be read, the target is
  used, and the failure-based fail-over above stays the safety net. The run log gets `provider_usage_skip`.
  With `on_exhausted: wait` the wake-up is the provider's reset time. See `docs/adrs/2026-11-13-usage-aware-fallback.md`.
- `providers: { fallback: [codex/gpt-5.5, claude/claude-opus-5-5] }` in `defaults/main.yaml` adds
  `provider/model` fallbacks to every step agent, after its tier's own entries, so a role with one model
  moves on too. Out of tokens is also detected when a turn ends normally on the provider's notice
  ("You've hit your weekly limit · resets Nov 16, 2pm"), not only on a failed turn. The manager can move a
  step to another model itself: `nudge_step`, `start_step` and `restart_run` take `model: provider/model`
  (and `thinking`) for that attempt; on `nudge_step` a new agent takes over the same attempt. `get_run`
  shows the model of each step and, in view `full`, the models of each attempt
  (see `docs/adrs/2026-11-11-step-model-override-failover.md`).
- **Fan-out steps** start one run of a playbook per item of a `list` value, each in its own workspace, `max_active` at a time, and join them with per-item results (`all_completed` / `some_failed`). The Playbooks screen draws one lane per child inside the parent run. A child canceled and started again for the same item is linked with `replace_child` (or `start_playbook` with `replaces`): the item stays running under the new run and the join waits for the last run of its chain (`docs/adrs/2026-11-13-fanout-replaced-child.md`, event `fanout.child_replaced`). An item created after the step started joins it live with `add_fanout_item { runId, stepId, item }` (the run's manager) or the panel's *Add item* field in the step's Fan-out section: it waits for a `max_active` slot like any pending item, shows in `pool.known` / `pending` / `active` so a refill never lists it again, and is refused when the step is not running or the key already exists (`docs/adrs/2026-11-18-add-fanout-item.md`, event `fanout.item_added`). See `docs/adrs/2026-11-12-fanout-join.md` and the `batch` example.
- **Work pools** (`fanout: { …, pool: { refill: { playbook, inputs: { done: "{{ pool.done }}" }, max_refills } } }`) keep a fan-out open: each time children finish, a refill pass (a run of a playbook that lists the items now ready, given the finished keys) adds the new items as children, up to `max_active`, without waiting for the slowest sibling. It ends when nothing runs and a pass adds nothing, unless the pool has `idle: { output, poll }` and the pass says blocked items remain: it then stays open, waiting, and re-plans when a child ends, when an item is added with `add_fanout_item` (accepted while it waits) or every `poll`. Events: `fanout.refill` (phase `started`/`ended`, with the `added` keys: why a child appeared) and `fanout.child_replaced`; `get_run` shows `pool: { refills, lastRefillAt, added, status, passes[] }` on the fan-out step. The pass playbook must be safe to run many times and use the finished keys (`pool.done`). See `examples/.paseo/plugins/playbooks/queue.yaml` and the skill.
- `role: { name: qa, completion: { auto: [success, merged] } }` lets the plugin apply those reported outcomes itself, without waking the manager (it must not call `complete_step`; the run log records it). Failures, other outcomes, and any case where a gate, hand-off, fan-out or the end of the run would come next still wake the manager. See `docs/adrs/2026-11-12-step-auto-completion.md` and the `release` example.
- **Run priority override** (`set_run_priority { runId, priority | null, applyToChildren? }`, also the `runs.set_priority` RPC behind the priority control of the Runs view; callable by any non-step agent, like `cancel_run`): sets or, with `null`, clears a run's manual quota priority, a whole number from -1000 to 1000 like `quota_limit.priority`. It wins over the playbook's priority and `start_playbook`'s `priority` in the quota pace plan, the admission queue and the `rateHold` text (higher first, ties oldest first), is applied at once (the pace plan is looked at again: a raised run resumes, a lowered one can be paused at its next step boundary; a running step is never interrupted) and lasts for the life of the run. `get_run` shows `priorityOverride` and `inheritChildPriority`; the history records `priority_changed` and `run.priority_changed` is emitted (from, to, inheritChildren, cascaded, by). `applyToChildren` is a sticky flag on a run with fan-out children: `true` copies the priority onto every child run now (recursively, cycle and depth safe) and onto each child the run starts later (refills, `replace_child`); `false` stops inheriting without resetting the children; omitted keeps the flag, and while it is on every change (a clear too) is passed down again. A child edited by itself keeps its own priority until its parent is edited again. Without the flag a parent's override does not reach its children. See `docs/adrs/2026-11-23-run-quota-priority-override.md`.
- `archive_run` archives an ended run like the panel's archive button (refused while active, or while its hand-off job is still open unless `force: true`; idempotent). `list_runs` hides archived runs unless `archived: true`. With `workspace: { archive_with_run: true }` (default true since v0.129.0; `false` opts out; in `defaults/main.yaml` or a playbook) archiving a run also archives the Paseo workspace it created, unless it has uncommitted changes or unpushed commits, and `workspace.archive_after` (default `6h`, or `never`) archives the workspace of a completed or canceled run that long after it ended; archiving a run also archives its Paseo workspace and every agent in it, only when no other unarchived run uses it, nothing in it runs or waits on a permission, and every visible agent in it belongs to a run; the `archive_run` result says `workspaceArchived` and why not. `restart_run` of such a run uses `workspaceId` to restart in another workspace. With `auto_archive: { enabled: true, after: 30m }` (off by default; in `defaults/main.yaml`, a profile's defaults or a playbook) the plugin archives a finished run (completed, failed or canceled) and its plugin-created manager `after` it ended (default 30 min), unless it has an open gate, a hand-off job still open or its manager is in a turn; the workspace follows `archive_with_run` and keeps unsaved or unpushed work, except that the workspace of a **failed run that can be restarted** is kept for `auto_archive.keep_failed_workspace` (default `24h`, counted from the failure) and archived then, with the same checks and never while another run in it is active; a run restarted in between is left alone, and `get_run` / `list_runs` show `workspaceKeptUntil` (also in the panel's run bar) while it is held; `restart_run` reopens it; `run.auto_archived` is emitted. Before the workspace is archived, the run's idle leftover agents (its manager, step and gate agents and every subagent they created, at any depth) are archived too; an agent that is not the run's keeps the workspace for good. A refusal that can clear (an agent still running or waiting on a permission, another run active in it) is asked again every 10 minutes for `keep_failed_workspace` more (then it is final); unsaved or unpushed work is final at once and written once. A run whose own worktree is already removed is treated the same. See also `docs/adrs/2026-11-23-auto-archive-failed-run-workspaces.md` and `docs/adrs/2026-11-23-auto-archive-leftover-agents.md`. See `docs/adrs/2026-11-20-auto-archive-runs.md`, `docs/adrs/2026-11-10-archive-run.md` and `docs/adrs/2026-11-17-archive-workspace-with-run.md`.
- A step may carry a `description` (plain text, for people: why and how the step exists). It shows at the top of the step's details sheet (the (i) of a graph node) and in `get_run` and `list_playbooks` (`view: full`); it is never put in an agent's prompt.
- `list_playbooks` returns a compact view by default in a `playbooks` array (`id`, `valid`, `errors`, and for a valid playbook its title, `hidden`, input names, step ids and after-tasks); `validate_playbooks` returns it in a `results` array (`id`, `valid`, `errors`, and for a valid playbook its title, `hidden`, `inputs`, `steps`, `after` and `source`, with `ref` and `note` when present). `view: "full"` and `playbookId` give the detail.
- Loop feedback (a `goto` back) goes in `complete_step`'s `summary`, not in `outputs`.
- `isolation: worktree` is prompt-directed: Paseo pins an agent's directory to its workspace, so agents
  start in the workspace and are told (and, by the guard, checked) to work only in the run's worktree.
  An agent that ignores the prompt fails its step; it is not prevented.
- Before a run's worktree is removed (run cleanup, the orphan sweep, or a deleted workspace), the plugin runs the
  repository's `worktree.teardown` commands from the worktree's `paseo.json` (a string or a list), in the worktree.
  A failing command is logged and does not stop the removal, so a repository can stop what it started there
  (for example a local stack). Paseo runs the same key itself when it archives a workspace it created.
- A run with `isolation: worktree` reads its playbook and roles from its own worktree, off a freshly fetched
  `origin/<base>`, so merged rules reach new runs without fast-forwarding the workspace checkout. If the fetch fails
  (or the playbook is missing or invalid on origin) the workspace checkout's copy is used and `start_playbook` says so.
  The definition is frozen at start; `restart_run` reuses it. `validate_playbooks` shows what a new run would load
  (`results[].source`). Only a playbook that already exists, valid and isolated, in the workspace checkout can be started.
  See `docs/adrs/2026-11-10-playbooks-from-fresh-main.md`.
  Scripts are pinned too: after a script fix lands on main, `refresh_scripts` (`runId?`, `reason`; managers and the Sidekick) makes
  the run's script steps run the scripts of the current `origin/<branch>`. On an active run only its `scripts/` folder is
  refreshed (the step definitions stay pinned). It also works on a failed (or any ended) run `restart_run` can reopen: it then
  re-reads the definition too (playbook, roles, defaults; when the steps are the same), so `refresh_scripts` then `restart_run`
  (or `restart_run` with `refresh: true`) runs the current scripts and rules, with the run's history and outputs kept; a run's
  scripts never run again by themselves. The source is `origin/<branch>` when the playbook there is valid; when it is invalid or
  missing, the workspace checkout is used and the result says so (`source: workspace`, `note` with the short validation error).
  A plain `restart_run` keeps the pinned scripts and definition. It records the commit in the run's history. See
  `docs/adrs/2026-11-13-refresh-run-scripts.md` and `docs/adrs/2026-11-18-refresh-scripts-failed-runs.md`.
  A run whose definition was read from the workspace checkout instead of origin (origin's playbook invalid, missing or
  unfetchable) shows a warning: `warnings` in `get_run`/`list_runs`, a `definition_fallback` history entry, a
  `run.definition_fallback` event, and a line in the run's details in the Playbooks panel.
- Plain Start picks the workspace's most recently used agent (the one you last sent a
  message to, skipping agents that already manage a run), because the panel cannot see
  which tab has focus. To pick a specific agent, send it a message first, or use "Start on
  a new agent".

## Permission requests

Run agents run in Bypass mode, yet Claude Code still asks about some compound or destructive-looking commands, and the
request would sit on the agent while the run hangs. `permissions: { on_request: authorize | escalate | deny }` (repo-wide in
`defaults/main.yaml`, overridable in a playbook; default `authorize`) tells the plugin what to do with a tool permission
request of any agent of a run (manager, step agents, role deciders, their subagents): `authorize` allows it on the human's
behalf; `escalate` opens a `permission` gate (allow / deny) like any human gate, decided in the panel or with `resume_gate`;
`deny` tells the agent to pick another way. Plans and mode changes stay with the human. Each outcome is a line of the
run history. See `docs/adrs/2026-11-17-permission-requests-policy.md`. The manager and step prompts also ask for simple
separate commands and the file tools, so requests are rarer.

A question the Playbook Manager asks the human in its own conversation (AskUserQuestion) is no run gate, so it would be
invisible in the panel. The plugin mirrors it as a `manager_question` gate: it is listed under "Needs you" with the run, the
question and its options as buttons (plus "Something else" for a typed answer; a question without options takes a typed
answer), and in `list_gates` (`kind: manager_question`, `stepId: manager`, choices `option-1`, `option-2`, ..., `other`, or
`answered`). Answering in the panel (or with `resume_gate`) delivers the answer to the manager's pending question; answering
in the manager's conversation closes the gate. The first answer wins, nothing is delivered twice. Several questions in one
request, or a multi-select, are listed with their text but answered in the manager's conversation (no buttons; the manager
button on the run opens it). A tool request is not duplicated: under `permissions.on_request: escalate` it is the `permission`
gate, not a question gate. See `docs/adrs/2026-11-18-manager-questions-as-gates.md`.

New Playbook-created Codex managers, step agents and gate deciders receive question guidance: offer 2–3 meaningful,
mutually exclusive choices for decision questions, mark an evidence-based recommendation with `(Recommended)`, and keep
an open-text route. Truly open-ended requests stay free-form without invented choices; existing playbook gates retain
exactly their declared choices. Claude prompts are unchanged. The panel preserves submitted labels and descriptions and
allows Other. The plugin cannot reject an empty or poor option list before submission because the native question tool
and its validation belong to Paseo's provider; guidance cannot guarantee model compliance. Existing agents are not
retrofitted; no run restart is needed or performed. See `docs/adrs/2026-11-19-codex-question-guidance.md`.


## Runs with no Playbook Manager

`manager: { mode: none }` in a playbook (default `always_on`; repo-wide default `manager: { lifecycle: none }` in
`defaults/main.yaml`) runs it without a manager agent: the plugin starts the steps, applies every reported outcome, opens the gates
(a human gate in the panel, a role gate with its decider) and stops the run in its failed state on a failure or a timeout.
See `examples/.paseo/plugins/playbooks/unattended.yaml` and `docs/adrs/2026-11-12-manager-mode.md`.
