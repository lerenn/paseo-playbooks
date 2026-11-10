Rules of the paseo-playbooks repository for the Sidekick. They add to the built-in rules, never replace them.

## This project
- It is the Paseo plugin that runs playbooks (client/ panel, server/ engine and loader, shared/, skills/). Its own playbooks live in `.paseo/plugins/playbooks/`: `docs.yaml` (the "Docs check" playbook: investigate, write, review, consistency, human approval), `roles/`, `defaults/main.yaml` (tiers: cheap step agents, sonnet manager) and this `sidekick/` folder.
- `examples/.paseo/plugins/playbooks/` holds example playbooks and a sample Sidekick; they are documentation, not this project's own setup.

## Rules for any change
- The playbook YAML format is the plugin's contract with its users. Before a change touches a playbook, step, after-task, transition, role or defaults field, the subagent reads `.agents/skills/extend-playbook-format/SKILL.md`. New options go in a block under the key they belong to, never as flat fields, and never a `type:` or `kind:` field.
- Every significant decision gets an ADR in `docs/adrs/`, in the same pull request. Significant: architecture or how the plugin talks to Paseo, the playbook format, run state or the agent tools' contract, a new UI surface, compatibility, dependencies, packaging or releases, the development workflow, or a rule an earlier ADR set. Bug fixes, refactors, copy edits and visual tweaks need none.
- ADR file: `docs/adrs/YYYY-MM-DD-<short-slug>.md`, dated the day of the decision, with Status, Context, Decision, Consequences. Keep it to one decision. Never rewrite an accepted ADR to change a decision: write a new one that supersedes it and set the old Status to `Superseded by <file>`. `2026-11-02-design.md` is closed; new decisions get their own file.
- A change to a shipped path (`client/`, `server/`, `shared/`, `skills/`, `assets/`, `index.client|server.tsx`, `paseo-plugin.json`, `OVERVIEW*.md`) needs a version bump in `package.json` and `package-lock.json` (`npm version <patch|minor|major> --no-git-tag-version`). CI runs `.github/scripts/check-version.mjs`. Files under `.paseo/`, `docs/`, `examples/` and `.github/` need no bump.
- `npm run typecheck` and `npx vitest run` must both pass before a pull request is opened.

## Pull requests and releases
- Pull requests are squash-merged by the human. The Release workflow tags `vX.Y.Z` when `package.json` changes on main, so a version bump is a release: never merge for the human, and choose the version level only when the human has said which.
- Title: a short imperative sentence, with the new version in parentheses when it bumps, for example "Provider fallback: a tier may list several providers (v0.57.0)". The description says what changed and why, names the ADR, and lists the runs that motivated it when there are some.

## Subagent hygiene
- Work in a worktree made from a fresh `origin/main`. Stage files by path: never `git add -A` or `git add .`. Never use a bare `git stash`. Never print the environment or secrets. Do not push to main or merge.

## What stays with the human
- Releases and the choice of the version number, anything that changes the plugin's contract with its users (the YAML format, tool names and arguments, run state), new dependencies, and anything about security or credentials. For these, report and wait; do not start a change.
- A gate about shipping a release is never answered by the Sidekick.

## What you may propose a fix for
- A docs gap the "Docs check" run reports: open a pull request with the doc fix (README, `OVERVIEW*.md` kept identical in meaning across languages, `skills/paseo-playbooks/SKILL.md`, `website/`).
- A flaky test: reproduce it with `npx vitest run`, then propose a fix or a skip with the reason.
- A failed version check: the subagent bumps the version only when the human has said which level.
- The same run failing twice for the same reason: propose a playbook, role or defaults change in a pull request, citing the runs.
