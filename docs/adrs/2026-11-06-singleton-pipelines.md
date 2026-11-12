# Singleton pipelines: a singleton is a long-lived pipeline whose steps are stations

Status: Accepted, except its hand-off step (waiting for the job's result), superseded by `2026-11-12-handoff-gives-the-task-away.md`

Supersedes `2026-11-06-singleton-playbooks.md` and `2026-11-06-handoff-steps.md` (the
hand-off step itself is kept, restated below; its settling rules change).

## Specification changes

| Change                              | Where        | Kind    | Summary                                                                    |
| ----------------------------------- | ------------ | ------- | -------------------------------------------------------------------------- |
| `singleton`                         | playbook     | changed | `{ branch }` only: one long-lived run per project, in one shared workspace |
| `singleton.concurrency` (key, limit)| playbook     | removed | Refused, with what to write instead: each step is a station               |
| `inputs`, `outputs`, `outcomes`     | playbook     | changed | On a singleton: all each job's (there are no run inputs any more)         |
| steps of a singleton                | playbook     | changed | Each top-level step is a station: a waiting list, one train at a time     |
| `boarding`                          | run status   | removed | Replaced by each station's waiting list                                    |
| `queue: { mode }`                   | station step | new     | `fifo` (default): one job per train; `merge`: all waiting jobs per train   |
| `retries`                           | station step | changed | Failed trains a job may ride again at that station, before it fails        |
| `settle_job`                        | manager tool | changed | `outcome` optional: without it, sets the job's outputs and the job goes on |
| `{{ run.jobs }}`, `PLAYBOOK_JOBS`   | prompts      | changed | The jobs of the current train, not of the whole run                        |

## Context

`2026-11-06-singleton-playbooks.md` gives a singleton one waiting list per key value and one
run (with its own worktree and manager) per group of jobs. Stages in order (dev, then stg,
then prd) are hand-off steps in every handing-off playbook, and each lane gets a new
worktree per train: a release process shows up as many look-alike workspaces, and its order
is repeated in each playbook that uses it.

The process itself is a graph: dev, then stg, then prd. Writing it as the singleton's own
steps keeps its order in one place, gives it one workspace, and lets the panel draw it as
one graph.

## Decision

### A singleton is a pipeline

A playbook that declares `singleton:` is run as **one long-lived pipeline per project**, in
**one shared workspace**. Its top-level steps are **stations**; jobs move through them along
`needs`. The pipeline is a run that keeps the stations' waiting lists and the jobs; it has no
manager and runs no step itself. Each **train** is an ordinary run of its station's steps
(a sub-playbook's expanded steps, or one step) in the same workspace.

```yaml
# release_trains.yaml
title: Release trains
singleton: { branch: main }            # its workspace branches off it (default: the default branch)
inputs:
  pr_url: { type: string, required: true }   # each job's
outputs:
  report: { type: string }                   # each job's
outcomes: [shipped, ejected]                 # each job's, when it leaves the pipeline
steps:
  - id: dev
    playbook: { name: train }
    inputs: { env: dev }
    queue: { mode: merge }               # every waiting job rides the same train
  - id: stg
    needs: [dev]
    playbook: { name: train }
    inputs: { env: stg }
    queue: { mode: merge }
  - id: prd
    needs: [stg]
    playbook: { name: train_prd }
    queue: { mode: merge }
```

- **Stations.** Each top-level step has a **waiting list** of jobs and runs **one train at a
  time**: when it is free and its waiting list is not empty, it takes jobs from the list and
  runs once for them (a sub-playbook block runs all its steps; a gate opens once; a script
  runs once). Jobs that arrive meanwhile wait for its next train.
- **Queue mode.** A station's `queue: { mode }` says which jobs a train takes: `fifo`
  (default) takes the oldest waiting job alone, so jobs go one at a time in arrival order;
  `merge` takes every waiting job, so jobs that piled up go together (a merge queue). There
  is no `lifo`: it can leave old jobs waiting forever, and would ship newer changes before
  older ones. `queue` applies only to a singleton's top-level steps. Stations run in
  parallel: dev runs its next train while stg runs its own.
- **Moving on.** A job enters the stations with no `needs`. When a train ends with its
  step's first outcome (a normal finish), every job of it that is still open has **passed**
  the station, and joins the waiting list of each station whose `needs` it has now all
  passed. A job that has passed every station leaves the pipeline: it is settled with the
  playbook's first outcome and its outputs, which must then all be set (otherwise it fails,
  naming what is missing).
- **Settling a job.** During a train, its manager calls `settle_job(runId, jobId, outputs,
  outcome?)`. Without `outcome`, it sets the job's outputs and the job goes on (a release tag
  cut on dev, read on stg). With an outcome of the playbook (`ejected`), the job ends now: the
  handing-off run is told at once, and the train goes on with the others.
- **A train that fails.** When a train fails, its open jobs go back to the front of its
  station's waiting list, in their order, and ride its next train: a "Not now" on a go gate,
  or a flaky apply, does not send them back through the earlier stations. The station's
  `retries` caps how many failed trains a job may ride there (default 0); past it, the job
  fails, and so does its hand-off step. A canceled train fails its open jobs at once. Jobs
  only move forward: `goto` between stations is refused. Inside a sub-playbook block, `goto`
  works as today (a QA asking for a redeploy loops within the train).
- **Inputs.** A singleton's playbook inputs are each job's (there are no run inputs): its
  steps read them through `{{ run.jobs }}`, now the jobs of the current train, each with its
  inputs and the outputs set at earlier stations (`PLAYBOOK_JOBS` for scripts), never wired as
  step inputs. A station's `inputs` take constants (`env: dev`), which a sub-playbook block
  passes on as its inputs, so `when` inside it works (`when: { env: prd }`).
- **Agents.** Each train has its own fresh Playbook Manager in the shared workspace, created
  when the train starts. The station's previous train manager is archived then, so the
  workspace holds one manager per station (dev, stg, prd). The pipeline run itself has no
  manager: the plugin moves jobs, starts trains and settles jobs. A train's manager uses the
  usual tools (`start_step`, `complete_step`, `request_gate`…) plus `settle_job`.
- **The run and its workspace.** The first hand-off (or Start in the panel) creates the run
  and its workspace, named after the playbook ("Release trains"), from `branch`. The run
  never completes. When no train is running, the plugin fast-forwards the workspace to
  `branch` and reads the playbook again: a merged change applies from the next train, and
  jobs waiting at a station that no longer exists fail. Canceling the run (or archiving its
  workspace) fails every open job; the next hand-off creates a new run.
- **One checkout, several trains.** Trains of different stations share the workspace, so
  every role the singleton uses (its blocks' included) must be `readonly`; validation refuses
  others. The plugin creates the trains itself: the "one active run per workspace" rule of
  `start_playbook` and Start does not apply to them, and still keeps other runs out of that
  workspace.
- **Pause.** Pausing the pipeline stops trains from starting; pausing a train pauses it like
  any run. `restart_run` does not apply to a pipeline or a train: a failed train's jobs ride
  the station's next train (or fail, past its `retries`).
- A singleton has no `concurrency` and no `after`, and cannot be a sub-playbook step or an
  after-task: its runs only come from hand-offs and Start.

### Hand-off steps

`handoff: { name: <singleton> }`, a step kind in block form
(`2026-11-06-group-step-kind-fields.md`), with `inputs`, `on`, `timeout` and `retries`:

- The target is a singleton of the same playbooks folder. The step's contract is the
  singleton's `inputs`, `outputs` and `outcomes`, plus `failure`; every outcome but the first
  (and `failure`) needs an `on` entry (`complete`, `end`, `fail` or `goto`, not `ask`).
  `outputs`, `outcomes` and the kind blocks of other steps do not apply.
- The plugin starts and completes it, as a script step: the manager is woken with the result.
  Its job enters the pipeline's first stations, and the step completes when the job leaves the
  pipeline (or is ended early). A playbook that uses the pipeline hands off once, not once
  per stage.
- Its `timeout` covers the whole pipeline, human gates included: set a long one, or none. On
  timeout, or when the run is canceled or the step reset (restart, `goto`), the job is
  withdrawn: it leaves its waiting lists, and the trains carrying it are told. While the run
  is paused, a result waits for the resume. Jobs are kept in run state across daemon restarts.
- Validation refuses a hand-off that leads back to its own playbook, directly or through
  other hand-offs.

## Consequences

- The specification a user writes is three things: `singleton: { branch }` on a playbook,
  ordinary steps (each a station, ordered by `needs`, with an optional `queue: { mode }`),
  and `handoff: { name }` where work is handed over. One tool, `settle_job`, settles jobs.
  There is no key, limit, lane, route or boarding status to learn.
- Two queue modes, chosen per station: `fifo` by default (what "a queue" means), `merge`
  for release trains. The train's manager does not pick its jobs (departures stay
  deterministic); it can only take a job out early with `settle_job`. Another mode, or a cap
  for `merge` (`max_jobs`), can be added to the `queue` block later without breaking
  anything.
- A release process is one file, one graph and one workspace; its order is no longer
  repeated in every playbook that hands work to it.
- Stations differ by input (`env`) or by playbook (`train_prd` with its own gate), with no
  key, lane or route concept.
- Trains reuse everything a run already does (steps, gates, scripts, timeouts, pause,
  wake-ups); the new parts are the pipeline's waiting lists and the job moves between trains.
  Run state gains `jobs` (with where each job is) and `train` (default `null`).
- Breaking for singletons written for v0.30.0 (`singleton.concurrency` is refused with what
  to write instead), allowed before v1.0 (`2026-11-03-format-stability-until-v1.md`): minor
  version. Run files from v0.30.0 with boarding runs are failed on load, their jobs with them.
- `when` (`2026-11-06-conditional-steps.md`) is unchanged; inside a station's block it reads
  the constants the station passes.
- The UI is decided in `2026-11-06-pipeline-card-layout.md` (which superseded `2026-11-06-pipeline-ui.md`).
