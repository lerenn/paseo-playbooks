# Warden PR checks: opt-in findings over open pull requests

## Status

Accepted. Extends `2026-11-18-warden.md`; it supersedes none of its rules.

## Context

The warden looks at runs. Several problems sit on the pull request instead: no reviewer asked, merge conflicts, an
automated review that never saw the latest push, required CI that did not run on the head commit, review findings nobody is
fixing, PRs no run owns, drafts left idle. A PR with no run is invisible to a per-run pass. The plugin has no GitHub access
today, and everything about reviewers, bots and CI is specific to a team's provider and setup.

## Decision

- A `pr_checks` block under `warden`, **in `defaults/main.yaml` only** (a playbook that sets it fails to load: the checks look at
  the project's PRs, not at one run, so they cannot be frozen into a run's playbook). Block form per the format rule: each check is its
  own block and is **on only when its block is set**; with no `pr_checks`, `warden.enabled: false`, or no check set, nothing runs
  (no `gh` call, file, event or message; tested). Shared options: `fix_step` and `review_bot: { author, receipt, retrigger }`.
  Checks (finding names are `pr_*`):
  `no_reviewer: { required: [logins] }`, `conflicting: {}`, `review_stale: { after }` (needs `review_bot`),
  `required_checks: { names, dispatch }`, `review_findings: {}` (needs `review_bot` and `fix_step`), `unowned: {}`,
  `draft_idle: { after }` (`30m`, `48h` or `7d`). Bad values and missing dependencies fail validation of `defaults/main.yaml`.
- Nothing provider-specific is built in: logins, the receipt regex, the re-trigger text and the dispatch command template
  (`{name} {sha} {branch} {pr}`) are all configuration.
- Data comes from the `gh` CLI (`gh pr list --state open --json ...`, run in the project root, with the user's own login): the plugin
  had no GitHub access to reuse. One read per project per `interval` (the warden's, default 15 min, at least 60 s). A failing `gh`
  is logged and the pass goes on; no token is stored by the plugin.
- A pass covers projects that have a Sidekick (that is where findings go). A PR **belongs to a run** of the project when the run's
  worktree or start branch is the PR's head branch, or the PR's URL appears in the run's step state; an active run wins, else the
  latest.
- The checks only detect. Each finding carries the run id (when any), the PR (number, URL), the cause (`detail`) and a **proposed
  action as text** (route the run to its fix step, re-trigger the review, dispatch the checks on the exact head SHA, request a
  reviewer, start a run, close the PR). The warden executes none of them; the Sidekick, with the human where needed, does.
- Findings reuse `diffFindings`: keyed by check and PR (`#12`), reported once, again after `cooldown` if still true, forgotten when
  they clear, a new signature (a new head SHA, a new review) is a new finding. They are kept per project in `warden-prs.json` (a PR
  finding may have no run), so a restart repeats nothing. They are sent as one message per pass to the project's Sidekick through the
  same path as the run findings (idle now, held otherwise). No new event, tool or panel surface: they are not in `get_run`.

## Consequences

- A team can opt in check by check and get unowned or stuck PRs in front of its Sidekick, without any name of a bot, reviewer,
  repository or workflow in the plugin.
- It needs the `gh` CLI signed in on the daemon's host; without it the pass logs and finds nothing.
- Ownership is a heuristic (branch or URL); a PR opened by a run under another branch name, without its URL in a step's state, reads
  as unowned.
- `required_checks` compares names against the head commit's reported checks and workflows: a check that was never reported is missing.
- The `WardenFinding` and `WardenCheck` types gain the `pr_*` names and optional `runId`, `pr`, `proposed` fields (defaulted: older
  run files load).
