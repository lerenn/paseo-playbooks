import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { completeStep, endTurn, newRun, recordReport, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { COMPACT_SUMMARY_MAX, defaultRunToCancel, describeEntries, gateSummaryMissing, runChange, runCompact, runFull } from "./tools";

/** Only the fields defaultRunToCancel reads. */
function run(id: string, managerAgentId: string, workspaceId: string, status: Run["status"] = "running"): Run {
  return { id, managerAgentId, workspaceId, status, after: {}, branch: `b-${id}`, workspaceDir: `/w/${id}`, playbook: { id: "pr" } } as unknown as Run;
}

describe("defaultRunToCancel", () => {
  it("picks the caller's own active run first", () => {
    const runs = [run("a", "other", "ws1"), run("b", "me", "ws2")];
    expect(defaultRunToCancel(runs, "me", "ws1").id).toBe("b");
  });

  it("falls back to the only active run of the caller's workspace", () => {
    const runs = [run("a", "m1", "ws1", "completed"), run("b", "m2", "ws1"), run("c", "m3", "ws2")];
    expect(defaultRunToCancel(runs, "me", "ws1").id).toBe("b");
  });

  it("asks for a runId when it cannot choose", () => {
    expect(() => defaultRunToCancel([run("a", "m1", "ws1"), run("b", "m2", "ws1")], "me", "ws1")).toThrow(/several runs.*a, b/);
    expect(() => defaultRunToCancel([run("a", "m1", "ws2")], "me", "ws1")).toThrow(/pass runId.*a \(pr, b-a\)/);
    expect(() => defaultRunToCancel([run("a", "m1", "ws1", "canceled")], "me", "ws1")).toThrow(/no run is active/);
  });
});

const PLAYBOOK = `
title: Views
inputs:
  request: { required: true }
steps:
  - id: investigate
    role: { name: investigator }
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: { name: implementer }
    needs: [investigate]
    inputs: [plan]
after:
  - id: retro
    role: { name: reviewer }
    trigger: manual
`;

let dir = "";
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function viewsRun(): Promise<Run> {
  dir = await mkdtemp(path.join(tmpdir(), "views-"));
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.resolve(__dirname, "..", "examples/.paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "views.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "views")!;
  expect(entry.errors).toEqual([]);
  const now = "2026-11-05T12:00:00.000Z";
  const run = newRun({ id: "run_v", playbook: entry.playbook as Playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: "b", managerAgentId: "m", inputs: { request: "Add X" }, now });
  startAttempt(run, "investigate", { agentId: "a1", brief: "", now, readonlySnapshot: null });
  recordReport(run, "a1", { outcome: "success", summary: "x".repeat(5000), outputs: { plan: "p".repeat(5000) } }, now);
  endTurn(run, "a1", { turnEnd: "completed", lastMessage: null, now });
  completeStep(run, "investigate", { outcome: "success", now });
  return run;
}

describe("manager views", () => {
  it("get_run compact keeps one short line per step, without reports, outputs or inputs", async () => {
    const run = await viewsRun();
    const compact = runCompact(run);
    expect(compact.steps.investigate).toEqual({ kind: "agent", status: "completed", outcome: "success", attempts: 1, turnEnd: "completed", summary: `${"x".repeat(COMPACT_SUMMARY_MAX)}…` });
    expect(compact.steps.implement).toMatchObject({ status: "ready", outcome: null, attempts: 0, summary: null });
    expect(compact.steps.retro).toMatchObject({ afterTask: "retro" });
    expect(compact.ready).toEqual(["implement"]);
    expect(compact.after).toEqual([{ id: "retro", trigger: "manual", status: "pending", detail: null }]);
    expect(compact).not.toHaveProperty("inputs");
    expect(JSON.stringify(compact).length).toBeLessThan(1500);
  });

  it("get_run full keeps every report and output; steps filters either view", async () => {
    const run = await viewsRun();
    const full = runFull(run);
    expect(full.inputs).toEqual({ request: "Add X" });
    expect(full.steps.investigate!.report!.summary).toHaveLength(5000);
    expect(full.steps.investigate!.outputs.plan).toHaveLength(5000);
    expect(Object.keys(runFull(run, ["implement"]).steps)).toEqual(["implement"]);
    expect(Object.keys(runCompact(run, ["implement", "investigate"]).steps)).toEqual(["investigate", "implement"]);
    expect(() => runCompact(run, ["nope"])).toThrow(/unknown step\(s\) nope/);
  });

  it("mutating tools return what changed: the step, what is next, open gates", async () => {
    const run = await viewsRun();
    const change = runChange(run, "investigate");
    expect(change).toEqual({
      runId: "run_v",
      status: "running",
      failure: null,
      active: true,
      paused: false,
      step: { id: "investigate", status: "completed", outcome: "success", attempts: 1 },
      ready: ["implement"],
      queued: [],
      running: [],
      gates: [],
      after: [{ id: "retro", trigger: "manual", status: "pending", detail: null }],
    });
    expect(runChange(run)).not.toHaveProperty("step");
  });
});

describe("playbook views", () => {
  it("compact by default keeps id, valid and errors; full keeps the detail; playbookId filters", async () => {
    await viewsRun();
    const loaded = await loadPlaybooks(dir);
    const compact = describeEntries(loaded.entries, "compact") as Array<Record<string, unknown>>;
    expect(compact.find((c) => c.id === "views")).toMatchObject({ id: "views", valid: true, errors: [], steps: ["investigate", "implement", "retro"], after: ["retro"] });
    expect(compact.find((c) => c.id === "views")).not.toHaveProperty("roles");
    expect(JSON.stringify(describeEntries(loaded.entries, "full")).length).toBeGreaterThan(JSON.stringify(compact).length);
    expect(describeEntries(loaded.entries, "full", "views")[0]).toHaveProperty("steps.0.needs");
    expect(describeEntries(loaded.entries, "compact", "views")).toHaveLength(1);
    expect(() => describeEntries(loaded.entries, "compact", "nope")).toThrow(/No playbook "nope" \(known: views\)/);
  });

  it("an invalid playbook is valid:false with its errors in both views", () => {
    const entry = { id: "bad", file: "bad.yaml", title: "bad", hidden: false, errors: ["steps: required"], playbook: null };
    for (const view of ["compact", "full"] as const) expect(describeEntries([entry], view)).toEqual([expect.objectContaining({ id: "bad", valid: false, errors: ["steps: required"] })]);
  });

  it("request_gate without a summary says what to give and where loop feedback goes", () => {
    expect(gateSummaryMissing("approve")).toMatch(/"summary".*complete_step's "summary"/s);
  });
});
