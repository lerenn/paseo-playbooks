# `isolation: worktree`: a private git worktree per run, agents directed by prompt

Status: Accepted

Supersedes `2026-11-09-run-isolation-worktree.md` (which waited for a Paseo core change).

## Context

One active run per workspace means parallel runs need one Paseo workspace each, and each
workspace piles up in the sidebar. The earlier proposal needed Paseo core to let an agent live in
a workspace with another cwd. It cannot today: the SDK and the daemon pin an agent's cwd to its
workspace, and any other cwd registers a new workspace.

## Decision

A "prompt-directed worktree". Agents keep starting in the run's original workspace (so the run
stays visible and busy there, and no workspace is created); the plugin creates a git worktree for
the run itself and tells every agent to work only in it.

- **Setting**: `isolation: none | worktree` (default `none`, so nothing changes), as a playbook
  field and in `defaults/main.yaml`. Block form `isolation: { mode, submodules, base }`; the
  string is shorthand for `{ mode }`. The playbook's fields win over the defaults', field by field.
  A singleton cannot ask for `worktree` (a repository default simply does not reach it); release
  trains are never isolated.
- **Create** (plugin code, at `start_playbook`): `git worktree add -b playbooks/<playbook>-<id>
  $PASEO_HOME/plugin-data/paseo-playbooks/worktrees/<runId> <fresh origin/base>`, reusing
  `freshRef`; `base` defaults to the project's default branch. Recorded in run state
  (`run.worktree`: path, branch, base, baseSha, linked submodules, the workspace snapshot, state)
  and shown by `list_runs` and `get_run`.
- **Submodules** (`submodules: none | all | [paths]`, default `none`). The monorepo this targets
  is a submodule monorepo; each submodule is its own repo, and its own tooling (`asdev worktree
  adopt`) links submodule worktrees. A bare `git worktree add` leaves submodule directories
  empty. `none` is the default because most runs touch one or two submodules, and initialising all
  of them is slow and large; agents init the ones they need (the preamble says how). `all` or a
  list links each as a detached worktree of the *workspace's own clone* of the submodule, at the
  commit the worktree pins: fast, no network, shared objects (a submodule the workspace never
  initialised is initialised in place). Stack/env provisioning (ports, `.asdev/env`) is not done.
- **Prompts**: `{{ worktree }}` in role prompts and role instructions (the worktree path; the
  workspace directory when the run is not isolated). A preamble leads the system prompt and the
  first message of every step and decider agent, and the manager's takeover and `start_playbook`
  result: absolute path, run commands as `cd <path> && ...` or `git -C <path>` (the shell resets
  outside the working directory), absolute paths for Read/Edit/Write, never touch the workspace.
- **Guard**: the workspace's `HEAD` and `git status` are recorded at run start. After each step
  (turn end or late report) and when the run ends they are compared; a change fails the step
  naming the paths (`isolation_violation` in the history) and warns the manager. A readonly
  role's existing check now covers the worktree. Limit: an edit to a file that was already dirty
  at run start with the same status line is not seen, and a human editing the workspace trips it.
- **Cleanup** (tick and turn end): once the run ended (after-tasks included) and none of its
  agents runs, the worktree and its branch metadata are removed: submodule worktrees are
  detached from their clones first, then `git worktree remove --force`, then, if git refuses, a
  delete after making directories writable, never outside the plugin's worktrees directory
  (checked by real path). The directory is kept, with `worktree_kept` in the history, when the
  run FAILED (not canceled) and `workspace.keep_failed` is true, when it has uncommitted changes, or when the
  guard fired. The branch is deleted unless it holds commits on no remote. A restart recreates
  the worktree on the run's branch (local, else origin, else fresh).
- **Sweep**: at daemon start, directories of the worktrees folder whose run is gone (or says
  `removed`) are deleted with their git metadata (uncommitted changes of such an orphan are
  dropped and logged), then `git worktree prune`. A run deleted with its workspace removes its
  worktree first.
- **Concurrency**: any number of isolated runs may share a workspace. A non-isolated run still
  needs the workspace alone: it is refused while an isolated run is active there, and an isolated
  run is refused while a non-isolated one is. Reservations of the panel's start are kept per
  workspace as a list, so concurrent starts do not collide. Applies to `start_playbook`, the
  panel's start, `start_after_task` and `restart_run`.

## Consequences

- Nothing changes for playbooks without `isolation`. New run field `worktree` (defaults to null).
- Isolation is prompt-directed: an agent that ignores the preamble is caught by the guard and
  fails its step, but is not prevented.
- Repositories with `{{ worktree }}`-less prompts that use relative paths work through the
  preamble; absolute paths in prompts to the workspace need `{{ worktree }}`.
- A restarted or late after-task step recreates a deleted worktree on demand.
- The panel is unchanged: Start in the same workspace (current agent or new agent) now works for
  isolated playbooks while other runs are active there.
