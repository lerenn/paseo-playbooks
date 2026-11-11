import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Playbook } from "../shared/types";
import { EngineError, endTurn, newRun, recordAutomaticReport, recordReport, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { stepTool } from "./tools";
import type { Runtime } from "./runtime";

const PLAYBOOK = `
title: Outcomes
inputs:
  request: { required: true }
steps:
  - id: land
    role: { name: investigator }
    inputs: [request]
    outcomes: [none, merged, not_merged]
    on:
      merged: complete
      not_merged: end
`;

let dir = "";
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function landRun() {
  dir = await mkdtemp(path.join(tmpdir(), "refused-"));
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "roles/investigator"), { recursive: true });
  await writeFile(path.join(root, "roles/investigator/role.yaml"), "title: Investigator\n");
  await writeFile(path.join(root, "roles/investigator/instructions.md"), "Investigate.\n");
  await writeFile(path.join(root, "outcomes.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "outcomes")!;
  expect(entry.errors).toEqual([]);
  const now = "2026-11-11T10:00:00.000Z";
  const run = newRun({ id: "run_o", playbook: entry.playbook as Playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: "b", managerAgentId: "m", inputs: { request: "x" }, now });
  startAttempt(run, "land", { agentId: "a1", brief: "", now, readonlySnapshot: null });
  return { run, now };
}

describe("a refused result never throws out of an automatic path", () => {
  it("recordReport refuses an outcome the step does not declare, naming the allowed ones", async () => {
    const { run, now } = await landRun();
    expect(() => recordReport(run, "a1", { outcome: "failure", summary: "boom", outputs: {} }, now)).toThrow(/use one of: none, merged, not_merged/);
  });

  it("recordAutomaticReport turns it into a failure report instead of throwing", async () => {
    const { run, now } = await landRun();
    expect(() => recordAutomaticReport(run, "a1", { outcome: "failure", summary: "boom", outputs: {} }, now)).not.toThrow();
    endTurn(run, "a1", { turnEnd: "completed", lastMessage: null, now });
    const report = run.steps.land!.attempts.at(-1)!.report!;
    expect(report.outcome).toBe("failure");
    expect(report.summary).toMatch(/boom \(result refused: outcome "failure" is not allowed; use one of: none, merged, not_merged\)/);
  });
});

describe("report_step_result", () => {
  it("returns the engine's refusal to the agent as a tool error, and keeps serving", async () => {
    const runtime = {
      outcomesOf: () => ["none", "merged", "not_merged"],
      report: async () => {
        throw new EngineError('outcome "failure" is not allowed; use one of: none, merged, not_merged');
      },
    } as unknown as Runtime;
    const tool = stepTool(runtime) as unknown as { execute: (input: unknown, ctx: unknown) => Promise<{ isError?: boolean; text: string }> };
    const call = () => tool.execute({ outcome: "none", summary: "s", outputs: {} }, { agent: { id: "a1" } });
    for (let i = 0; i < 2; i++) {
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/use one of: none, merged, not_merged/);
    }
  });
});
