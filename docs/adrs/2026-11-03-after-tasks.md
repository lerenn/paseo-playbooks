# After-tasks: children that run around the run, not in it

Status: Accepted

## Context

Some work must follow every run whatever its outcome, the main case being a retro that
reflects on the run to improve the playbook. A last step in the graph does not fit: `fail`
and `end` skip it, its failure would fail the run, and a nested playbook would repeat it.
Chaining (`next`) was removed (`2026-11-03-remove-chaining.md`); playbooks combine only as
parent and child.

## Decision

- A playbook may declare `after:`, a list of tasks. Each task is an agent step (role and
  prompt) or a sub-playbook (`playbook: <id>`), with `trigger: auto` (default) or
  `trigger: manual`.
- After-tasks belong to the same run: same run file, same manager, shown in the same
  panel graph, drawn outside the main graph.
- They do not affect the run. The run's status (`completed` or `failed`) is fixed when the
  main graph ends; an after-task's failure is recorded on the task only.
- `auto` tasks start when the run completes or fails, not when it is canceled. `manual`
  tasks appear as a button on the finished run, in any end state.
- They receive `{{ run.id }}`, `{{ run.status }}`, the run's (possibly partial) outputs and
  its failure reason; `get_run` gives them the full history.
- A sub-playbook's `after` is ignored when it is nested; only the outermost playbook's
  after-tasks run.
- An after-task has no `needs` (each task starts on its own) and never ends or fails the
  run: inside after-tasks, `end` completes the task, and `fail` or exhausted retries fail
  the task only. Several `auto` tasks may run at once, so the "two steps that may edit
  files" rule applies between after-tasks, but not between an after-task and a main step.
- A sub-playbook used as an after-task keeps its own steps, gates and loops; its
  `concurrency` is ignored there.
- Canceling the run during after-tasks cancels them; it does not change the run's status.
  Archiving the worktree or losing the manager does the same.
- Details settled while implementing: an input of an after-task matches by name the
  playbook's outputs, then `run_id` / `run_status` / `run_failure`, then the playbook's
  inputs; `{{ run.outputs.<name> }}` and main steps' outputs can be mapped explicitly. A
  manual task runs once. Auto tasks of a canceled run (or one whose manager was lost) are
  marked canceled, never started. In a sub-playbook used as an after-task, `end` at its top
  level completes the task and a nested block's `end` ends only that block
  (`2026-11-03-end-inside-block.md`). While after-tasks run, the run stays active in its
  workspace (no new run there, no archive).
- No `before:` for now: a pre-task that matters is a first step, one that does not is a
  notification. Add it when a concrete need appears.

## Consequences

- A retro is one `after:` entry pointing at a `retro` playbook, and runs once per run,
  including failed ones.
- The run file, engine, panel and manager tools learn a post-run phase ("wrapping up").
- Playbook format change: minor version bump.
