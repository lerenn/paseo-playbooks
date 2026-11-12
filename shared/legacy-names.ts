/**
 * The deprecated names of the stage/batch rename (ADR 2026-11-12-stage-batch-rename): "station" is now "stage"
 * and "train" is now "batch". The old names keep working until `LEGACY_NAMES_END`; this file is where the
 * state written under them is read back, so the rest of the code only knows the new names.
 */

/** Last day the old names are supported. After it they may be removed without notice (see the ADR). */
export const LEGACY_NAMES_END = "2027-02-12";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** `{ station, … }` as `{ stage, … }`; an entry already written with the new name is left alone. */
function stageEntry(entry: unknown): unknown {
  if (!isObj(entry) || !("station" in entry)) return entry;
  const { station, ...rest } = entry;
  return { ...rest, stage: rest.stage ?? station };
}

/** A job as an older run file or log wrote it: `waiting[].station` and `riding[].station` are stages, `riding` is `batches`. */
export function upcastJobNames<T>(job: T): T {
  if (!isObj(job)) return job;
  const { riding, ...rest } = job;
  const out: Obj = { ...rest };
  if (Array.isArray(out.waiting)) out.waiting = out.waiting.map(stageEntry);
  const batches = out.batches ?? riding;
  if (Array.isArray(batches)) out.batches = batches.map(stageEntry);
  return out as T;
}

/** A run snapshot (a `<run>.json` file) as an older plugin wrote it, before it goes through `RunSchema`. */
export function upcastRunNames(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const run: Obj = { ...raw };
  if ("train" in run) {
    const { train, ...rest } = run;
    Object.assign(run, rest);
    delete run.train;
    run.batch ??= isObj(train) ? stageEntry(train) : train;
  }
  if (Array.isArray(run.jobs)) run.jobs = run.jobs.map(upcastJobNames);
  if (isObj(run.playbook) && isObj(run.playbook.singleton) && "stations" in run.playbook.singleton) {
    const { stations, ...rest } = run.playbook.singleton;
    run.playbook = { ...run.playbook, singleton: { ...rest, stages: rest.stages ?? stations } };
  }
  return run;
}

/** The data of a logged job event, with the old field names read as the new ones (events keep what they were written with). */
export function upcastEventData(data: Obj): Obj {
  const out: Obj = { ...data };
  const rename = (from: string, to: string) => {
    if (from in out) {
      out[to] ??= out[from];
      delete out[from];
    }
  };
  rename("station", "stage");
  rename("trainRunId", "batchRunId");
  rename("trainStatus", "batchStatus");
  rename("clearRiding", "clearBatches");
  rename("nextStations", "nextStages");
  if (Array.isArray(out.queued)) out.queued = out.queued.map(stageEntry);
  if (isObj(out.job)) out.job = upcastJobNames(out.job);
  return out;
}
