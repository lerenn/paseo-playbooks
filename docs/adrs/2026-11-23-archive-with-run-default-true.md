# Archiving a run archives its workspace by default

## Status

Accepted. Supersedes decision 2 of `2026-11-17-archive-workspace-with-run.md` (the default of
`workspace.archive_with_run`). The option, its safety rules and its results (decisions 1 and 3 to 6 of that
ADR) stand.

## Context

`2026-11-17-archive-workspace-with-run.md` made `workspace: { archive_with_run }` opt-in (default false),
because archiving a workspace archives every agent in it. The plugin now defaults it to true for runs started
after this change: the loader sets `archiveWithRun` to true when neither the playbook nor `defaults/main.yaml`
sets it (`server/loader.ts`). No ADR records that change, and the repository does not say why it was made.
Two statements were stale: the zod fallback in `shared/types.ts` still says false, and the `archive_run`
tool description in `server/tools.ts` reads as if the option were opt-in.

## Decision

- `workspace.archive_with_run` defaults to **true** for runs started after this change. When a run is archived,
  its workspace and the agents in it are archived too, under the safety rules of the 2026-11-17 ADR: no other
  unarchived run uses the workspace, nothing in it runs or waits on a permission, every visible agent carries a
  plugin label. One more rule is in the code and is not in the 2026-11-17 ADR: the workspace has no uncommitted
  change and no commit on a local branch that no remote has (`unsavedWork` in `server/git.ts`, checked by
  `archiveWorkspaceWithRun` in `server/runtime.ts` when the workspace is not the project's root checkout).
- A run saved before the field existed keeps `false`. Its run file is parsed by `RunSchema` when the plugin
  starts (`server/store.ts`), and the zod fallback in `shared/types.ts` fills in `archiveWithRun: false`. So when
  such a run is archived, its workspace is not archived with it. The default above does not reach those runs.
- `workspace: { archive_with_run: false }` opts out, in a playbook or in `defaults/main.yaml`. The playbook's
  own value wins over the default.

## Consequences

- Archiving a run started after this change also archives its workspace unless someone opts out. This is the
  change the 2026-11-17 ADR warned about for existing users, and it applies only to runs started after it.
  The docs (README, `OVERVIEW*.md`, the SKILL and the website) say so and give the opt-out.
- The zod fallback in `shared/types.ts` stays `false`: it is what keeps runs saved before the field existed
  opted out. Changing it to `true` would archive the workspaces of those runs too, which this ADR does not
  decide. The `archive_run` tool description in `server/tools.ts` should describe the default instead of
  "unless `archive_with_run: true` is set"; this ADR did not check that text.
- `archive_after` (`workspace.archive_after`) does not read `archive_with_run`: an aged workspace is archived
  under the same checks whether or not the option is on. The docs do not say so; this is a code fact to decide on.
- Before this ADR is merged, the reason for the change should be written here, if it was deliberate: the
  repository does not record it.
