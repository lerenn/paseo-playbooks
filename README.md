# Paseo Playbooks

> [!WARNING]
> Until v1.0, any minor release may change the playbook YAML format in breaking ways. Pin the
> plugin to a release tag (`paseo plugin install https://github.com/lerenn/paseo-playbooks.git --ref v0.7.0`,
> then `paseo plugin update paseo-playbooks --ref <tag>`) and read the release notes before upgrading.

Paseo plugin for multi-agent workflows: write a playbook in YAML, and a manager agent runs
each step as a subagent, in parallel or in loops, through to the human approval gates. See [OVERVIEW.md](OVERVIEW.md) for what it does and
[docs/adrs/2026-11-02-design.md](docs/adrs/2026-11-02-design.md) for the design.

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

The Sidekick is long-lived and found by its labels: `playbooks/sidekick` and `playbooks/project=<project id>`
(`paseo ls -g` lists them), so any agent can send it a prompt. It relays the human's answers to managers
(`send_agent_prompt`, `respond_to_permission`) and checks the gate moved, and creates its subagents on
`sidekick.subagents` (`provider`, `model`; default `claude` / `claude-sonnet-5-5`; optional `mode`, a Paseo
mode id such as `default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`, set on every subagent; unset, they
inherit the Sidekick's own `sidekick.mode`, and if that is unset too the plugin sends none and Paseo's default mode
for the provider applies; a value that is not a mode id is ignored with a warning); their finish notices wait
until it is idle. It saves a short decision ledger with `sidekick_handoff`. When its context passes
`sidekick.session.restart_above_tokens` (default 300000) it is asked to hand off and is replaced by a new
session that starts from the ledger.

`start_playbook` starts the run's ready agent steps itself, as `start_step` would with no brief (same model, role and
workspace resolution); pass `autoStart: false` to leave them ready. Script, hand-off and gate steps are not started
this way, and `start_step` on a step already running is refused. This also holds for runs started from the panel, whose
manager calls `start_playbook`.

A script step's sheet in the run graph shows whether a check is **running now** or the step is **waiting** ("next
check in ~30 s"), the running check's output (refreshed about every 2 s) and the last five checks with their
outcome and exit code. The output is kept in memory only (the last 4000 characters per check, gone when the step
ends or the daemon restarts, after which the run's recorded last-check output is shown) and is not redacted:
anyone who can see the panel sees what the script prints. Each check says what started it: the first run, the poll,
or an event ("woken by job.settled").

A script step can also wake on events: `script: { run: check.sh, poll: 10m, wake_on: [{ types: [job.advanced, job.settled],
filter: { playbook: other_pipeline, station: production } }] }` runs a check at once when a matching event is emitted
(`types` take globs; `filter` matches payload fields by equality), and `poll` stays as the safety net (required). Events
during a running check cause one more check after it, never two at once; checks are at least 5 s apart; a step is not woken
by events about itself. See `examples/.paseo/plugins/playbooks/wait_for_upstream.yaml` and
`docs/adrs/2026-11-12-script-wake-on.md`.

The Sidekick can start playbook runs with `start_playbook` (`workspaceId` of a visible workspace of its project, or
that with `newWorkspace`, and `workspaceName` to title the new workspace; never its own hidden workspace), and `list_playbooks` shows what is on offer. When you ask
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

Run state is still one JSON file per run. Next to it, a pipeline (a singleton's run) and its trains keep an
append-only **event log**, `<run id>.events.jsonl`, in the plugin's `runs/` folder: one line per fact about its jobs
(`job.queued`, `job.boarded`, `job.advanced`, ...), the first step of the event core (ADR
`docs/adrs/2026-11-12-event-core.md`). In this version the log changes nothing: the run file stays the source of truth,
and the log is checked against it. Two settings in the user config
(`$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/config.yaml`, read when the plugin starts, so reload after editing):

```yaml
event_core:
  log: true        # false: write no log and check nothing (the way back; state is the same either way)
  parity: warn     # warn: log a line when the log's reducers and the run state disagree; off: no check
```

The pipeline's jobs are also announced on the event bus, for `subscribe_events` and `list_events`:
`job.queued` (waits at a station: handed off, or unlocked by a passed station; one event per station),
`job.boarded`, `job.advanced` (passed a station), `job.requeued` (its train failed, retries left), `job.settled`
(left with an outcome), `job.failed`, `job.withdrawn`. Payload: `runId` (the pipeline), `playbook` (the singleton's id),
`jobId`, `label`, `station`, `trainRunId`, `outcome`, plus `via`, `nextStations`, `rides`/`retries`, `summary` or `reason`
per type. `filter` matches them by equality, e.g. `{ playbook: "release_trains", station: "stg" }`.

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
`.paseo/plugins/playbooks/` or `.paseo/playbooks/`),
adjust the roles and playbooks and commit them. Then open the Playbooks panel in a workspace of
that repository and press Start. Start runs the playbook with the workspace's most
recently used agent as manager (see Known limits), in that workspace (the run starts at
once, but if that agent is busy, its kickoff waits until its current turn ends). The arrow
next to Start offers "Start on a new agent", which creates a new manager agent in the same
workspace, and "Start in a new workspace", which creates a new worktree and manager.

The **Run Playbook** button in the header of the overview screen (the one with the Runs, Analytics and Profiles tabs,
next to Sidekick) opens a form to start any valid playbook of a project in a new workspace: a project dropdown
(preselected to the project chip selected on the screen; with "All projects" you choose one), a workspace name (optional; empty keeps the default title, the playbook title and the
request), a playbook dropdown, then that playbook's inputs. **Start**, at the bottom, creates the workspace and the run;
a failure shows in the form, a success as a toast ("Started <playbook> in <workspace>"); the screen stays where it was, the new run appears in the list, and the new workspace is not opened. The name is a title only (one line, at most 80 characters): the
branch is still `playbooks/<playbook>-<id>`. The same title is available to agents as `workspaceName` on
`start_playbook` with `newWorkspace`. The button is shown when a project has a startable playbook (disabled while the
lists load). The per-workspace Playbooks tab has no such button: its cards offer "Start in a new workspace", which
has the same workspace name field.

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
- After a plugin update, idle agents whose session holds the old plugin's tools are reloaded (history
  kept) so they stop failing with "Tool not found"; an agent mid-turn is reloaded when its turn ends,
  never one waiting on a permission or question. Turn off with `reload_stale_sessions: false` in
  `defaults/main.yaml`. Agents from before v0.51.0 are reloaded only if they belong to a run
  (see `docs/adrs/2026-11-09-reload-stale-sessions.md`).
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
- `providers: { fallback: [codex/gpt-5.5, claude/claude-opus-5-5] }` in `defaults/main.yaml` adds
  `provider/model` fallbacks to every step agent, after its tier's own entries, so a role with one model
  moves on too. Out of tokens is also detected when a turn ends normally on the provider's notice
  ("You've hit your weekly limit · resets Nov 16, 2pm"), not only on a failed turn. The manager can move a
  step to another model itself: `nudge_step`, `start_step` and `restart_run` take `model: provider/model`
  (and `thinking`) for that attempt; on `nudge_step` a new agent takes over the same attempt. `get_run`
  shows the model of each step and, in view `full`, the models of each attempt
  (see `docs/adrs/2026-11-11-step-model-override-failover.md`).
- **Fan-out steps** start one run of a playbook per item of a `list` value, each in its own workspace, `max_active` at a time, and join them with per-item results (`all_completed` / `some_failed`). The Playbooks screen draws one lane per child inside the parent run. See `docs/adrs/2026-11-12-fanout-join.md` and the `batch` example.
- `role: { name: qa, completion: { auto: [success, merged] } }` lets the plugin apply those reported outcomes itself, without waking the manager (it gets a quiet inbox line and must not call `complete_step`). Failures, other outcomes, and any case where a gate, hand-off, fan-out or the end of the run would come next still wake the manager. See `docs/adrs/2026-11-12-step-auto-completion.md` and the `release` example.
- `archive_run` archives an ended run like the panel's archive button (refused while active, or while its hand-off job is still open unless `force: true`; idempotent). `list_runs` hides archived runs unless `archived: true`. See `docs/adrs/2026-11-10-archive-run.md`.
- `list_playbooks` and `validate_playbooks` return a compact view by default (`results[].id`, `.valid`, `.errors`); `view: "full"` and `playbookId` give the detail.
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
- Plain Start picks the workspace's most recently used agent (the one you last sent a
  message to, skipping agents that already manage a run), because the panel cannot see
  which tab has focus. To pick a specific agent, send it a message first, or use "Start on
  a new agent".

## Runs with no Playbook Manager

`manager: { mode: none }` in a playbook (default `always_on`; repo-wide default `manager: { lifecycle: none }` in
`defaults/main.yaml`) runs it without a manager agent: the plugin starts the steps, applies every reported outcome, opens the gates
(a human gate in the panel, a role gate with its decider) and stops the run in its failed state on a failure or a timeout.
See `examples/.paseo/plugins/playbooks/unattended.yaml` and `docs/adrs/2026-11-12-manager-mode.md`.
