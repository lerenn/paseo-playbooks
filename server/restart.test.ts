import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { restartBlocker } from "../shared/types";
import { cancelRun, completeStep, endTurn, newRun, readySteps, recordReport, restartRun, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** investigate → (implement ∥ docs) → review, with an auto after-task. */
const MAIN = `
title: Main
inputs:
  request: { required: true }
steps:
  - id: investigate
    role: investigator
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: implementer
    needs: [investigate]
    inputs: [plan]
    outcomes: [success, give_up]
    on:
      give_up: fail
  - id: docs
    role: reviewer
    needs: [investigate]
    outputs: { page: {} }
  - id: review
    role: reviewer
    needs: [implement, docs]
after:
  - id: retro
    role: reviewer
`;

async function playbook(): Promise<Playbook> {
  const dir = await mkdtemp(path.join(tmpdir(), "restart-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "main.yaml"), MAIN);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "main")!;
  expect(entry.errors).toEqual([]);
  return entry.playbook!;
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++)).toISOString();

function start(pb: Playbook): Run {
  return newRun({ id: "run_r", playbook: pb, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "Add X" }, now: now() });
}

function begin(run: Run, stepId: string): string {
  const agentId = `a-${stepId}-${clock}`;
  startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
  return agentId;
}

function step(run: Run, stepId: string, outcome = "success", outputs: Record<string, string> = {}) {
  const agentId = begin(run, stepId);
  recordReport(run, agentId, { outcome, summary: `${stepId} ${outcome}`, outputs }, now());
  endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  return completeStep(run, stepId, { outcome, now: now() });
}

describe("restart a finished run from a step", () => {
  it("reopens a canceled run: the step runs again, finished steps keep their outputs, after-tasks run at the end", async () => {
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "the plan" });
    step(run, "docs", "success", { page: "docs.md" });
    begin(run, "implement");
    cancelRun(run, "canceled from the panel", now());
    expect(run.status).toBe("canceled");
    expect(run.after.retro!.status).toBe("canceled");

    const fx = restartRun(run, "implement", { comment: "use the new API", by: "laptop", now: now() });
    expect(run.status).toBe("running");
    expect(run.failure).toBeNull();
    expect(readySteps(run)).toEqual(["implement"]);
    expect(run.steps.docs).toMatchObject({ status: "completed", outputs: { page: "docs.md" } });
    expect(run.steps.investigate!.outputs).toEqual({ plan: "the plan" });
    expect(run.steps.implement!.feedback).toMatch(/use the new API/);
    expect(run.after.retro!.status).toBe("pending");
    expect(run.history.at(-1)).toMatchObject({ type: "run_restarted", stepId: "implement" });
    expect(fx.notes.join(" ")).toMatch(/restarted from "implement"/);

    // The new attempt receives the kept outputs and the comment.
    const agentId = `a-implement-${clock}`;
    const started = startAttempt(run, "implement", { agentId, brief: "", now: now(), readonlySnapshot: null });
    expect(started.attempt.n).toBe(2);
    expect(started.attempt.inputs.plan!.value).toBe("the plan");
    expect(started.prompt).toMatch(/Restarted from this step by a human: use the new API/);
    completeStep(run, "implement", { outcome: "success", now: now() });
    step(run, "review");
    expect(run.status).toBe("completed");
    expect(run.after.retro!.status).toBe("running");
  });

  it("puts back unfinished parallel steps, and rewinds everything after an earlier step", async () => {
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "p" });
    begin(run, "implement");
    begin(run, "docs");
    cancelRun(run, "stop", now());
    restartRun(run, "implement", { comment: null, by: null, now: now() });
    // docs was cut short by the cancel: it is ready again too.
    expect(readySteps(run).sort()).toEqual(["docs", "implement"]);
    expect(run.steps.implement!.feedback).toBeNull();

    cancelRun(run, "again", now());
    restartRun(run, "investigate", { comment: null, by: null, now: now() });
    expect(readySteps(run)).toEqual(["investigate"]);
    expect(run.steps.investigate!.outputs).toEqual({});
    expect(run.steps.implement!.status).toBe("pending");
  });

  it("restarts a failed run whose after-tasks already ran: they are pending again", async () => {
    const run = start(await playbook());
    step(run, "investigate", "success", { plan: "p" });
    step(run, "implement", "give_up");
    expect(run.status).toBe("failed");
    expect(run.after.retro!.status).toBe("running");
    step(run, "retro");
    expect(run.after.retro!.status).toBe("completed");

    restartRun(run, "implement", { comment: null, by: null, now: now() });
    expect(run.status).toBe("running");
    expect(run.after.retro).toEqual({ status: "pending", startedAt: null, endedAt: null, detail: null });
    expect(readySteps(run).sort()).toEqual(["docs", "implement"]);
  });

  it("refuses active runs, steps whose needs did not complete, after-task steps and archived runs", async () => {
    const run = start(await playbook());
    expect(restartBlocker(run, "investigate")).toMatch(/only a finished run/);
    step(run, "investigate", "success", { plan: "p" });
    begin(run, "implement");
    cancelRun(run, "stop", now());
    expect(restartBlocker(run, "review")).toMatch(/needs implement, docs/);
    expect(() => restartRun(run, "review", { comment: null, by: null, now: now() })).toThrow(/needs implement, docs/);
    expect(restartBlocker(run, "retro")).toMatch(/after-task/);
    expect(restartBlocker(run, "docs")).toBeNull();
    run.archivedAt = now();
    expect(restartBlocker(run, "docs")).toMatch(/archived/);
  });
});
