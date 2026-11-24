import { describe, expect, it } from "vitest";
import { startRun } from "../shared/contracts";
import type { QuotaProject } from "../shared/quota-limitation";
import type { Playbook } from "../shared/types";
import { chosenPriority, playbookPriority, showsPriority } from "./run-form";

const limits = (pacing: boolean) => ({ repos: ["default"], pacing, usablePercent: 80, stepsLimit: null, runsLimit: null });
const project = (...sets: boolean[]): QuotaProject => ({ projectId: "p", label: "P", limits: sets.map(limits) });
const playbook = (priority?: number) => ({ id: "x", rateLimit: priority === undefined ? undefined : { priority } }) as unknown as Playbook;

describe("Run Playbook form priority", () => {
  it("shows only while burn rate limiting paces the project", () => {
    expect(showsPriority(project(true))).toBe(true);
    expect(showsPriority(project(false, true))).toBe(true);
    expect(showsPriority(project(false))).toBe(false);
    expect(showsPriority(project())).toBe(false);
    expect(showsPriority(undefined)).toBe(false);
  });
  it("defaults to the playbook's own priority, 0 without one", () => {
    expect(playbookPriority(playbook(7))).toBe(7);
    expect(playbookPriority(playbook(-3))).toBe(-3);
    expect(playbookPriority(playbook())).toBe(0);
  });
  it("sends an override only when the chosen value differs from the default", () => {
    expect(chosenPriority(7, playbook(7))).toBeUndefined();
    expect(chosenPriority(0, playbook())).toBeUndefined();
    expect(chosenPriority(8, playbook(7))).toBe(8);
    expect(chosenPriority(0, playbook(7))).toBe(0);
  });
  it("is validated like set_run_priority on the runs.start input", () => {
    const base = { workspaceId: "w", playbook: "p", inputs: {} };
    const input = startRun.input;
    expect(input.safeParse({ ...base, priority: 1000 }).success).toBe(true);
    expect(input.safeParse({ ...base, priority: -1000 }).success).toBe(true);
    expect(input.safeParse({ ...base }).success).toBe(true);
    expect(input.safeParse({ ...base, priority: 1001 }).success).toBe(false);
    expect(input.safeParse({ ...base, priority: 1.5 }).success).toBe(false);
  });
});
