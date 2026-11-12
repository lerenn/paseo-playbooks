# Per-outcome effects of a `settle` step: `continue` and `requeue`

## Status

Accepted

## Context

A batch of a singleton pipeline carries several jobs. When one is blocked and the others are fine (a release step held 1 of 4 jobs because a blocker was not ready), the tools were an outcome that ends the job for its hand-off, or a batch-level failure that fails every job (4 failed, all requeued by hand). Louis' decision: a mixed batch reports per-job results; jobs that are fine continue, blocked ones are set aside. The plugin stays generic: it knows no profile, station or code host; only playbook YAML and roles do.

## Decision

1. **The playbook declares what an outcome does to the job**, in a block under `settle` (`.agents/skills/extend-playbook-format`): `settle: { output: job_results, effects: { blocked: requeue, partial: continue } }`. The keys are outcomes of the singleton (`outcomes`, never the first one, the normal finish). Effects: `terminal` (the default, an outcome not listed: the job ends and its hand-off is told, as `ejected` and `no_deploy` do), `continue` (the job stays in its batch and its outputs are set, as with no outcome), `requeue` (see 2). No outcome name is built in: any outcome can be declared `requeue`. One meaning per outcome per stage (the loader refuses two `settle` steps of a stage that disagree). An outcome a stage declares `continue` or `requeue` needs no `on` entry in a waiting hand-off, since it never reaches it.
2. **`requeue`**: the job leaves the batch and goes back to the waiting list of the batch's stage, at the place it had (same `since`), **without** incrementing `failedRides` (so `retries` is not spent). Its outputs and passed stages are kept. The batch goes on with the others: the job is no longer in `{{ run.jobs }}`, `PLAYBOOK_JOBS` or the batch's open jobs, so later steps (a script waiting on something) only see the jobs still in the batch. The step ends `success`; per-job results ride in its `settle` output. The same applies to `settle_job { outcome }`, which resolves the effect from the stage.
3. **`reason` and `blocker` are opaque strings.** A requeue needs a `reason` (the entry's `reason`, or `settle_job`'s `summary`); `blocker` is optional and may be anything (a URL, a ticket, a sentence). The plugin stores and shows them (job `requeued: { stage, outcome, reason, blocker, at }`, events, UI, `get_run`) and never interprets them. `blocker` is refused with an outcome that does not requeue.
4. **Cap.** `queue: { max_requeues: N }` on a stage (a block under `queue`, like `mode` and `admit`) caps how often outcomes may requeue one job at that stage (`Job.requeues`, by stage; default unset = no cap, 0 = never). Past it, the job ends `failed` and its summary carries the outcome, reason and blocker; its hand-off is told `failure`. A cap without any `requeue` effect in the stage is a load error.
5. **A job can be requeued more than once**, up to the cap (each requeue counts; a batch that takes it again clears the mark, not the count). Every requeue is visible: history `job_requeued`, the domain and public event `job.requeued` with `cause: outcome` (batch-failure requeues keep `cause: batch_failed`, `rides`, `retries`), `outcome`, `reason`, `blocker`, `requeues` (the count at this stage), and the UI (a "Requeued" badge with the outcome, reason and blocker on the waiting job; nothing shown before is removed).
6. **Waiting for the blocker is the profile's job.** The plugin does not poll anything. A stage with `queue.admit` gets the requeued job held (`requeued (<outcome>: <reason> (blocker: ...))`, `checkedAt: null`) until the script has looked again; the script receives `requeued: { outcome, reason, blocker }` on the job in `PLAYBOOK_JOBS` and admits it once its blocker is gone. Without `admit`, the next batch may take the job at once.
7. **State and events.** `Job` gains `requeued` (null by default) and `requeues` (`{}`): older runs load unchanged; `requeued` is mirrored on the batch's copy and cleared when a batch takes the job, it ends, or it is reopened. The domain event `job.requeued` gains the `cause: outcome` form (reducer, parity-checked, replayed from the log).

## Consequences

- A mixed batch no longer needs to fail: blocked jobs are set aside, the others continue, nothing is requeued by hand.
- A requeued job may ride again immediately on a stage without `admit`, and be requeued again until `max_requeues`; stages that must wait need an admission script, and should set a cap.
- Format: `settle.effects` and `queue.max_requeues`. `settle_job` gains `blocker`; `list_events`/`subscribe_events` change the `job.requeued` payload (new fields; `rides`/`retries` are null for a requeue by outcome). Minor version (0.95.0).
