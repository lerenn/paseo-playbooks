# Rename station to stage and train to batch, with deprecated aliases

Status: Accepted

Builds on `2026-11-06-singleton-pipelines.md`, which introduced stations and trains, and
`2026-11-12-event-core-job-events.md` (the `job.*` events).

## Context

A singleton pipeline's top-level steps were "stations", the runs that carry its jobs were "trains", and the
vocabulary around them was railway too (boards, departs, riding). Most readers do not hear a railway in "a job
waits", and the metaphor made the docs harder to read. "Stage" and "batch" say what the things are.

## Decision

One change renames the concept everywhere (code, run state, events, UI, docs, examples, tests). The old names stay
as **deprecated aliases until 2027-02-12** (three months), then may be removed.

| Old | New |
| --- | --- |
| station | stage |
| train | batch |
| boards / boarded | joins / joined |
| riding | in a batch |
| departs | starts |

- **Events.** `job.boarded` becomes `job.joined`; both are emitted for every join until the end date (`job.boarded`
  is registered as a deprecated twin). Payloads of every `job.*` event carry both `stage` / `station` and
  `batchRunId` / `trainRunId`; `job.advanced` carries `nextStages` and `nextStations`. Subscriptions and `wake_on`
  rules saved with the old type or field names keep matching and validating. The log event `train.ended` is now
  `batch.ended`; history entries `train_departed` / `train_ended` are now `batch_started` / `batch_ended`.
- **Run state.** `run.train` is `run.batch` (`{ pipelineId, playbook, stage }`), a job's `riding` is `batches`, and
  `station` is `stage` in `waiting` and `batches` entries and in `playbook.singleton.stages`. New files are written
  with the new names only. `shared/legacy-names.ts` upcasts old run files when the store loads them, and the job
  reducers read old log events (`job.boarded`, `train.ended`, `station`, `trainRunId`, `clearRiding`, old genesis
  jobs) as the new ones, so an old log still replays.
- **Tools and scripts.** `PLAYBOOK_STATION` is set next to `PLAYBOOK_STAGE`. `get_run` jobs carry `riding` next to
  `batches`, and `list_playbooks` carries `stations` next to `stages`. The `runs.admission` RPC answers with both
  `stages` and `stations`.
- **YAML.** The format has no key named after either word, so the loader needs no new key; the old names that a
  playbook can use are the `wake_on` types and filter fields above, and they are accepted as before.
- **UI.** The pipeline's "Stations" row is "Stages", the "Trains" list is "Batches".
- **Not renamed.** Names that are user data (the `release_trains` playbook, `dev` / `stg` / `prd`, a `batch` example
  playbook) and the retry counters (`rides`, `failedRides`). The legacy run status `boarding` stays as it is.
- Accepted ADRs keep their original wording; this one is the key to read them by.

## Consequences

- Subscribers see each join twice (`job.joined` and `job.boarded`) until 2027-02-12; a subscription to `job.*`
  gets both. Migrate to the new type and fields before then.
- A run file written by this version cannot be read by an older plugin (the field names differ).
- `AGENTS.md` and the extend-playbook-format skill say old forms fail until v1.0; this rename is a deliberate
  exception, because event subscribers and scripts live outside the repository.
- After the end date: delete `shared/legacy-names.ts`, the old reducer keys, the `job.boarded` twin, the deprecated
  payload fields and tool output keys, and `PLAYBOOK_STATION`.
