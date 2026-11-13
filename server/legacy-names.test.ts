import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LEGACY_NAMES_END, upcastEventData, upcastRunNames } from "../shared/legacy-names";
import { RunSchema, type Playbook, type Run } from "../shared/types";
import * as engine from "./engine";
import { loadPlaybooks } from "./loader";
import { applyEvent, type DomainEvent } from "./event-core";
import { EVENT_AREAS, RunStore } from "./store";

/** What the stage/batch rename (ADR 2026-11-12-stage-batch-rename) must still read: state and logs written with "station" and "train". */

const T0 = "2026-11-01T00:00:00.000Z";
const at = (n: number) => `2026-11-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const APPLY = `
title: Apply
singleton: { branch: main }
inputs:
  pr_url: { type: string }
outcomes: [done]
steps:
  - id: dev
    gate: { question: Applied on dev? }
  - id: prd
    needs: [dev]
    gate: { question: Applied on prd? }
`;
let apply: Playbook;
beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "legacy-pb-"));
  dirs.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "apply.yaml"), APPLY);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "apply");
  if (!entry?.playbook) throw new Error(`apply playbook: ${entry?.errors.join("; ")}`);
  apply = entry.playbook;
});

/** A pipeline and a batch run as v0.90 wrote them to disk. */
function oldRunFiles(): { pipeline: Record<string, unknown>; batch: Record<string, unknown> } {
  const base = engine.newPipelineRun({ id: "pipe", playbook: apply, workspaceId: "ws", workspaceDir: "/w", projectId: "p", branch: "main", now: T0 });
  const job = { id: "j1", fromRunId: "r1", fromStepId: "s", attempt: 1, label: "PR", inputs: {}, status: "open", outcome: null, summary: null, outputs: {}, createdAt: T0, endedAt: null, passed: ["qa"], waiting: [{ station: "prd", since: T0 }], riding: [{ station: "dev", runId: "t1", since: T0 }], failedRides: {}, detached: false, requeued: null, requeues: {}, followUps: [], reopens: [] };
  const { stages, ...singleton } = base.playbook.singleton!;
  const pipeline = { ...JSON.parse(JSON.stringify(base)), jobs: [job], playbook: { ...JSON.parse(JSON.stringify(base.playbook)), singleton: { ...singleton, stations: stages } } };
  const batch = { ...JSON.parse(JSON.stringify(base)), id: "t1", jobs: [], train: { pipelineId: "pipe", playbook: "apply", station: "dev" } };
  return { pipeline, batch };
}

describe("run files written before the stage/batch rename", () => {
  it("are read with the new names", () => {
    const { pipeline, batch } = oldRunFiles();
    const run = RunSchema.parse(upcastRunNames(pipeline));
    expect(run.jobs[0]).toMatchObject({ waiting: [{ stage: "prd" }], batches: [{ stage: "dev", runId: "t1" }] });
    expect(run.playbook.singleton!.stages.map((stage) => stage.id)).toEqual(["dev", "prd"]);
    expect(run).not.toHaveProperty("train");
    const loaded = RunSchema.parse(upcastRunNames(batch));
    expect(loaded.batch).toEqual({ pipelineId: "pipe", playbook: "apply", stage: "dev" });
    expect(loaded).not.toHaveProperty("train");
  });

  it("are loaded by the store, and a file with the new names is left as it is", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "legacy-"));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    const { pipeline, batch } = oldRunFiles();
    await writeFile(path.join(dir, "pipe.json"), JSON.stringify(pipeline));
    await writeFile(path.join(dir, "t1.json"), JSON.stringify(batch));
    const store = new RunStore(dir);
    await store.init();
    expect(store.get("t1")!.batch?.stage).toBe("dev");
    const migrated = store.get("pipe")!;
    expect(migrated.jobs[0]!.batches).toHaveLength(1);
    expect(JSON.stringify(upcastRunNames(JSON.parse(JSON.stringify(migrated))))).toBe(JSON.stringify(migrated));
  });
});

describe("event logs written before the stage/batch rename", () => {
  const replay = (run: Run, events: DomainEvent[]) => {
    for (const event of events) applyEvent(EVENT_AREAS, run, event);
  };

  it("replay: job.boarded and train.ended with station / trainRunId", () => {
    const { pipeline } = oldRunFiles();
    const run = RunSchema.parse(upcastRunNames({ ...pipeline, jobs: [] }));
    const job = { ...(oldRunFiles().pipeline.jobs as Record<string, unknown>[])[0]!, waiting: [{ station: "dev", since: at(1) }], riding: [], passed: [] };
    replay(run, [
      { type: "job.queued", at: at(1), data: { job } },
      { type: "job.boarded", at: at(2), data: { station: "dev", trainRunId: "t1", jobIds: ["j1"], since: { j1: at(1) } } },
      { type: "train.ended", at: at(3), data: { trainRunId: "t1", station: "dev", status: "completed" } },
    ]);
    expect(run.jobs[0]).toMatchObject({ waiting: [], batches: [{ stage: "dev", runId: "t1" }] });
    expect(run.history.map((entry) => entry.type)).toEqual(expect.arrayContaining(["batch_started", "batch_ended"]));
  });

  it("replay: a genesis with the old job shape", () => {
    const { pipeline } = oldRunFiles();
    const run = RunSchema.parse(upcastRunNames({ ...pipeline, jobs: [] }));
    replay(run, [{ type: "jobs.genesis", at: at(1), data: { state: { jobs: pipeline.jobs, gates: [] } } }]);
    expect(run.jobs[0]).toMatchObject({ waiting: [{ stage: "prd" }], batches: [{ stage: "dev" }] });
  });

  it("reads old event data as the new names, and keeps the new names as they are", () => {
    expect(upcastEventData({ station: "dev", trainRunId: "t", trainStatus: "failed", clearRiding: true })).toEqual({ stage: "dev", batchRunId: "t", batchStatus: "failed", clearBatches: true });
    expect(upcastEventData({ stage: "dev", batchRunId: "t" })).toEqual({ stage: "dev", batchRunId: "t" });
  });

  it("names the day the aliases end", () => {
    expect(LEGACY_NAMES_END).toBe("2027-02-12");
  });
});
