# Warden PR checks: several repositories, rulesets, review markers, failed runs

## Status

Accepted. Builds on `2026-11-20-warden-pr-checks.md`; it supersedes none of its rules.

## Context

The first PR checks read one repository (the project root's), compared `required_checks` against a static list, took a
review's CHANGES_REQUESTED state as "open findings", and looked only at pull requests. Real projects work in several
repositories, keep the required checks in the base branch's ruleset (so a static list goes stale), have review bots that
state their result in a machine-readable marker in a comment rather than in the review state, and have hand-off or release
runs whose failure nobody sees until a PR is stuck. Everything provider-specific must stay configuration and opt-in.

## Decision

All new options sit in blocks under `warden.pr_checks` (still `defaults/main.yaml` only). Without them nothing changes.

- **`repos: { names: [owner/repo], from_runs: false }`.** Not a check: it chooses what is scanned. Each repository is read with
  `gh pr list --repo <repo>`; with `from_runs: true` the repositories whose PR URLs appear in the project's (unarchived) runs' step
  state are added. Unset: the project root's repository, as before. Chosen over discovery from worktrees because a run's state
  already holds the URLs it produced and no new run field or git call is needed. `names` and `from_runs` cannot both be empty.
  A repository that fails is logged and skipped; its earlier findings are kept (neither cleared nor repeated) until it reads again.
  With `repos` set, a PR's subject is `owner/repo#N` (numbers collide across repositories); without it `#N` as before.
- **Ownership per repository.** A PR URL in a run's state owns the PR exactly. A branch match alone owns it only when the run is
  not known to work in another repository: when its step state names PR URLs and none is in the PR's repository, the branch match
  is ignored. A run that names no PR URL is matched by branch, as before.
- **`required_checks: { names, from_ruleset, workflows, dispatch }`.** `from_ruleset: true` adds the status checks the PR's base
  branch requires, read once per repository and base branch per pass with `gh api repos/<repo>/rules/branches/<base>` (the
  `required_status_checks` rules' `context`s). A failed call (no permission, no such branch, no `gh`) is logged once with its reason
  and skipped: that branch keeps its static `names`, and no finding is made from the failure. `names` may be empty with
  `from_ruleset`. `workflows` maps a check name to a workflow, named in the proposal and available as `{workflow}` (and `{repo}`) in
  the `dispatch` template; unmapped, `{workflow}` is the check name.
- **`review_findings: { marker: { pattern, truthy } }`.** `pattern` is a regex with one capture group, `truthy` a regex the captured
  text matches when findings are open (default `^(true|yes|[1-9]\d*)$`). The bot's (`review_bot.author`) latest comment or review
  whose body matches `pattern` decides; a later marker that reads falsy clears the finding. When `marker` is set it replaces the
  CHANGES_REQUESTED rule (the marker is the bot's own statement and survives a review state that nobody dismissed); when unset the
  old behaviour is unchanged. Both patterns are validated when the file loads.
- **`failed_run: { playbooks: [ids], within: 24h }`, check `run_failed`.** A run of one of the listed playbooks (by id: the user
  chooses which are hand-off or release kinds) that is `failed`, or has a step in `failed`, within `within` of the failure, is
  proposed to the Sidekick with the run id, the failing step and the error text (the run's failure, else the step's report summary,
  last message or summary, cut at 400 characters). It has no PR, so it needs no `gh` read: with only `failed_run` set, none is made.
  Like the others it only proposes (read the run, retry or restart if the cause is transient, tell the human what broke).

## Consequences

- A team can scan the repositories its runs work in, follow the required checks of the repository instead of copying them, and
  trust the review bot's own marker, all without a provider, login or repository name in the plugin.
- More `gh` calls per pass: one list per repository, and one API call per repository and base branch with `from_ruleset`.
- Ownership across repositories remains a heuristic: a run that has opened no PR yet and shares a branch name with a PR in another
  repository still reads as its owner.
- `run_failed` is not a PR check; it sits under `pr_checks` so the Sidekick gets one message through the one path, with the same
  deduplication, file and cooldown. The `WardenCheck` type gains `run_failed`; the `WardenPrConfig` type gains `repos` and
  `failedRuns` and its `requiredChecks` and `reviewFindings` gain fields (run files are unaffected: it is configuration, not run
  state).
