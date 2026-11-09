# `isolation: worktree`: a private git worktree per run, with no Paseo workspace

Status: Superseded by 2026-11-09-isolation-worktree.md (the core change was not needed: agents are directed by prompt)

## Context

One active run per workspace means parallel runs need one Paseo workspace each, and each
workspace piles up in the sidebar and in `~/.paseo/worktrees`
(`2026-11-09-workspace-archive.md` cleans those up, but they are still created). The idea:
the plugin creates a private git worktree per run itself, step agents use it as their cwd, and
no Paseo workspace is created, so several runs can be active in one workspace.

## Findings (tested on the local daemon, 2026-11-09)

1. **The plugin SDK pins an agent's cwd to its workspace.** `workspaces.ref(id).agents.create`
   has no `cwd` option; `@getpaseo/client` sets it to the workspace's `workspaceDirectory`.
   Only the top-level `agents.create({ cwd, ... })` takes a cwd.
2. **The daemon pins it too.** `paseo run --workspace <id> --cwd /tmp` created the agent with
   cwd = the workspace's directory; the `--cwd` was ignored.
3. **A cwd outside any workspace is accepted, but the daemon registers a workspace for it.**
   `paseo run --cwd /tmp/<git repo>` (outside the agent scope) printed `Created workspace
   wks_…`, listed under a new project, `ISOLATION local`, in the sidebar. So an agent always
   belongs to a workspace; "no workspace" cannot be had with today's core. (Both test agents
   and the workspace were archived afterwards.) The `background` creation option, "visibility
   intent for a NEW workspace", may hide that workspace; it was not tested and would still
   leave a workspace per run, to archive.
4. Plugin side, if the core allowed it: `run.workspaceDir` is already the cwd of step agents,
   scripts and the read-only checkout check (`checkoutSnapshot(run.workspaceDir)`), so those
   follow a per-run directory. The Playbook Manager is an agent of a workspace and finds its
   run by workspace (`startPlaybook` refuses a second active run per workspace; tools and
   the panel group runs by `workspaceId`), so several runs per workspace need a run id on every
   manager tool call or one manager per run, and the panel's per-workspace run list and
   `list_runs` filters need review.

## Proposed core change

Let an agent live in a workspace while its cwd is another directory: either
`workspaces.ref(id).agents.create({ cwd })` (accepted when the directory exists and is in the
workspace's git repository or a linked worktree of it; today ignored), or top-level
`agents.create({ cwd, workspaceId })` with no workspace auto-created for the cwd. The workspace
`isolation: workspace` of today stays the default; nothing changes without the core change.

## Decision (when unblocked)

Per playbook and in `defaults/main.yaml`: `isolation: workspace | worktree` (a block per the
format rules, e.g. `run: { isolation: worktree }`, to settle in the implementing ADR). With
`worktree`, all by plugin code, no agent involved:

- Location: `$PASEO_HOME/plugin-data/paseo-playbooks/worktrees/<runId>` (the plugin data dir the
  run store already uses), never `~/.paseo/worktrees`.
- Created at run start with `git worktree add` from a freshly fetched `origin/<base>`;
  path and branch recorded in the run state and shown by `list_runs` and `get_run`.
- Removed when the run completes or is canceled, after checking `git status --porcelain` and
  unpushed commits (`git log @{u}..`, or with no upstream compared with origin). Anything
  uncommitted or unpushed keeps the worktree, with a history entry naming why; never
  `--force`. A failed or manager-lost run keeps it while `workspace.keep_failed` is true.
- A reconciler, at daemon start and every N minutes (default 30, configurable), removes the
  worktrees of ended or unknown runs with the same checks, then runs `git worktree prune`;
  idempotent, logged, so crashes cannot leave orphans.
- Tests: create, remove, keep when dirty, keep when unpushed, keep on failure, orphan sweep
  after a simulated restart.

## Consequences

- Nothing ships now; `isolation` is not accepted by the loader yet.
- Needs a Paseo core change first; then an implementing ADR supersedes this one.
