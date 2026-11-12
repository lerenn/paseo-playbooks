import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { overviewStateRpc } from "../shared/contracts";
import { isActive, isPipeline, RunSummarySchema, summarizeRun, type Playbook, type Run } from "../shared/types";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
let playbook: Playbook;

beforeAll(async () => {
  const result = await loadPlaybooks(EXAMPLES);
  playbook = result.entries.find((entry) => entry.id === "pr")!.playbook!;
});

const gate = (id: string, status: string): Run["gates"][number] => ({
  id,
  kind: "gate",
  jobId: null,
  stepId: playbook.steps.find((step) => step.kind === "gate")?.id ?? playbook.steps[0]!.id,
  gotoTarget: null,
  outcome: null,
  status,
  message: "Ship it? Details follow.",
  summary: "Ship it?",
  details: "Details follow.",
  requestedAt: "2026-11-10T10:00:00.000Z",
  comment: null,
  decidedBy: null,
  decidedVia: null,
  decider: { by: "human" },
  deciderAgentId: null,
  escalated: null,
  escalatedAt: null,
  decidedAt: status === "pending" ? null : "2026-11-10T10:05:00.000Z",
});

/** A run that has been going a long time: a big history, a big input, reports on its steps. */
function heavyRun(): Run {
  const run = newRun({
    id: "run_heavy",
    playbook,
    workspaceId: "ws",
    workspaceDir: "/tmp/ws",
    projectId: "proj",
    branch: null,
    managerAgentId: "manager",
    inputs: { request: `Fix the flaky test\n${"background ".repeat(2000)}` },
    now: "2026-11-10T09:00:00.000Z",
  });
  run.history = Array.from({ length: 2000 }, (_, index) => ({ seq: index, at: run.createdAt, type: "event", stepId: null, detail: "x".repeat(200) }));
  run.inbox = Array.from({ length: 50 }, () => "y".repeat(200));
  for (const step of playbook.steps) {
    run.steps[step.id]!.outputs = { notes: "z".repeat(5000) };
    run.steps[step.id]!.summary = "s".repeat(2000);
  }
  run.gates = [gate("g1", "approved"), gate("g2", "pending")];
  return run;
}

describe("summarizeRun", () => {
  it("keeps what the overview draws from", () => {
    const run = heavyRun();
    const first = playbook.steps[0]!;
    run.steps[first.id]!.status = "running";
    run.pausedAt = "2026-11-10T09:30:00.000Z";
    run.seenAt = "2026-11-10T09:40:00.000Z";
    run.name = "flaky-fix";
    const summary = summarizeRun(run);
    expect(RunSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({ id: "run_heavy", workspaceId: "ws", projectId: "proj", managerAgentId: "manager", name: "flaky-fix", status: run.status, pausedAt: run.pausedAt, seenAt: run.seenAt, batch: null });
    expect(summary.steps[first.id]).toEqual({ status: "running", startedAt: null, endedAt: null });
    expect(Object.keys(summary.steps)).toEqual(Object.keys(run.steps));
    expect(summary.playbook.steps.map((step) => step.id)).toEqual(playbook.steps.map((step) => step.id));
    expect(summary.playbook.title).toBe(playbook.title);
    expect(isActive(summary)).toBe(isActive(run));
    expect(isPipeline(summary)).toBe(isPipeline(run));
  });

  it("keeps the pending gates only, whole, and a one-line title cut short", () => {
    const summary = summarizeRun(heavyRun());
    expect(summary.gates.map((open) => open.id)).toEqual(["g2"]);
    expect(summary.gates[0]!.summary).toBe("Ship it?");
    expect(summary.title).toBe("Fix the flaky test");
    expect(summarizeRun({ ...heavyRun(), inputs: { request: "a".repeat(5000) } }).title).toHaveLength(200);
    expect(summarizeRun({ ...heavyRun(), inputs: { request: "  " } }).title).toBeNull();
  });

  it("leaves out history, outputs, attempts, inbox, prompts and job payloads", () => {
    const run = heavyRun();
    run.jobs = [
      {
        id: "j1",
        fromRunId: "r",
        fromStepId: "s",
        attempt: 1,
        label: "Job one",
        inputs: { big: "i".repeat(10_000) },
        status: "open",
        outcome: null,
        summary: null,
        outputs: { big: "o".repeat(10_000) },
        createdAt: run.createdAt,
        endedAt: null,
        passed: [],
        waiting: [{ stage: "dev", since: run.createdAt, held: null, forced: false }],
        batches: [],
        failedRides: {},
        detached: false,
      },
    ];
    const summary = summarizeRun(run);
    for (const key of ["history", "inbox", "inputs", "outputs", "workspaceDir", "branch", "loops"]) expect(summary).not.toHaveProperty(key);
    const text = JSON.stringify(summary);
    expect(text).not.toContain("zzzz");
    expect(text).not.toContain("background");
    expect(text).not.toContain("iiii");
    expect(summary.jobs).toEqual([{ id: "j1", label: "Job one", status: "open", waiting: [{ stage: "dev", since: run.createdAt, held: null, forced: false }] }]);
    for (const step of summary.playbook.steps) expect(step).not.toHaveProperty("prompt");
  });

  it("is much smaller than the full run", () => {
    const run = heavyRun();
    const full = JSON.stringify(run).length;
    const small = JSON.stringify(summarizeRun(run)).length;
    expect(small).toBeLessThan(full / 20);
  });

  it("fits the overview.state output contract", () => {
    const output = { runs: [summarizeRun(heavyRun())] };
    expect(overviewStateRpc.output.parse(output)).toEqual(output);
  });
});
