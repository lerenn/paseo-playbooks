# Hand-offs without waiting: `handoff: { wait: false }`, and rework runs in a new workspace

Status: Superseded by `2026-11-12-handoff-gives-the-task-away.md`

Amends the hand-off step of `2026-11-06-singleton-pipelines.md` (opt-in; its default is
unchanged).

## Specification changes

| Change                         | Where        | Kind | Summary                                                                        |
| ------------------------------ | ------------ | ---- | ------------------------------------------------------------------------------ |
| `handoff.wait`                 | hand-off step | new  | `false`: done with the first outcome once the pipeline takes the job          |
| `detached` (job)               | run state    | new  | The job belongs to the pipeline; default `false`, so older run files load      |
| `detached: true` in `run.jobs` | prompts      | new  | Marks those jobs for the train's manager (`PLAYBOOK_JOBS` too)                 |
| `start_playbook.newWorkspace`  | manager tool | new  | Starts the run in a new workspace with its own Playbook Manager                |

## Context

A hand-off step waits until its job leaves the pipeline, and canceling or ending the
handing-off run withdraws the job. Playbooks that hand a change to a release train
(ticket-to-prod, pr-to-prod, vuln-fix) have nothing left to do after the hand-off: they want to
end, and leave the release to the pipeline. When the pipeline ejects such a job, rework has
to start from the pipeline side, but a train's manager could not call `start_playbook`: its
workspace (the pipeline's) always has an active run, and its kickoff told it not to.

## Decision

- `handoff: { name, wait }`, `wait` defaulting to `true` (today's behaviour). With
  `wait: false`, the step completes with the singleton's first outcome as soon as its job is
  in the pipeline's first stations. It completes with `failure` if the job cannot be handed
  off.
- Such a step gives no outputs. Validation refuses reading `steps.<id>.outputs.*` from it (the
  error says why), and refuses `on` entries for any outcome but the first and `failure`. Every
  other outcome needs no `on` entry.
- Its job is **detached**: the pipeline owns it. It survives the handing-off run completing,
  failing or being canceled, and a reset of the step (restart, `goto`) does not withdraw it (a
  restarted step hands off a new job). The handing-off run is never woken by it: not by its
  settlement, nor by its train's gates. Its end is recorded on the pipeline only. The job keeps
  `fromRunId`, `fromStepId` and its label, so its card still shows where it came from, and
  the hand-off attempt keeps the job's reference.
- `start_playbook` takes `newWorkspace` (default `false`). With it, the plugin creates a new
  workspace branched off the caller's current branch, with a new Playbook Manager that starts
  the run there, as the panel's "Start in a new workspace" does. The caller does not manage
  the new run. A singleton is refused this way: it already has its own workspace. A train's
  kickoff now says to use this to start other playbooks (rework for an ejected job).
- The plugin does not decide when to rework: the singleton's playbook says it in a step prompt
  (after `settle_job(..., outcome: ejected)`, call `start_playbook` with `newWorkspace: true`).

## Consequences

- A playbook can hand a change to a release train and end; the train carries it on alone.
- Its playbook cannot branch on how the release ends. If it must, it keeps `wait: true`.
- Ejected work can be restarted from the pipeline, by any playbook and with inputs taken from
  the job, without a new tool.
- `wait` is a new optional key in the existing `handoff` block (block first,
  `2026-11-06-group-step-kind-fields.md`); playbooks without it behave as before. Minor version.
