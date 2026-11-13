import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRun } from "../server/engine";
import { loadPlaybooks } from "../server/loader";
import { leanRun, stepDetail, withDetail } from "./lean";
import { AttemptSchema, RunSchema, type Run } from "./types";

let dir = "";
let base: Run;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lean-"));
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.resolve(__dirname, "..", "examples/.paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "t.yaml"), "title: T\ninputs:\n  x: { type: string, default: hi }\nsteps:\n  - id: a\n    role: { name: implementer, prompt: \"Do the thing please\" }\n");
  const entry = (await loadPlaybooks(dir)).entries.find((e) => e.id === "t")!;
  if (!entry.playbook) throw new Error(JSON.stringify(entry.errors));
  const playbook = entry.playbook;
  base = newRun({ id: "run_x", playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: "2026-01-01T00:00:00.000Z" });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const attempt = (n: number, over: Record<string, unknown> = {}) =>
  AttemptSchema.parse({
    n,
    agentId: `agent-${n}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    brief: "brief",
    inputs: { x: { value: "v".repeat(1000), source: "run" } },
    report: { outcome: "success", summary: "s".repeat(1000), outputs: { k: "o".repeat(1000) } },
    lastMessage: "m".repeat(1000),
    outcome: null,
    turnEnd: null,
    readonlySnapshot: null,
    prompt: "p".repeat(5000),
    ...over,
  });

function withAttempts(): Run {
  const run = structuredClone(base);
  run.steps.a!.attempts = [attempt(1), attempt(2)];
  return run;
}

describe("leanRun", () => {
  it("drops the heavy text, stays a valid run, and keeps what the panel shows", () => {
    const run = withAttempts();
    const lean = leanRun(run);
    expect(() => RunSchema.parse(lean)).not.toThrow();
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(run).length / 2);
    const [first, latest] = lean.steps.a!.attempts;
    expect(first).toMatchObject({ n: 1, prompt: "", inputs: {}, lastMessage: null, report: { outcome: "success", summary: "", outputs: {} }, brief: "brief" });
    // The latest attempt keeps what the sheet and the graph card show: its report and last message in full, inputs as far as they are shown.
    expect(latest!.report).toEqual(run.steps.a!.attempts[1]!.report);
    expect(latest!.lastMessage).toBe("m".repeat(1000));
    expect(latest!.inputs.x!.value).toHaveLength(300);
    expect(lean.history.every((entry) => entry.type === "step_skipped")).toBe(true);
    expect(lean.playbook.steps[0]!.prompt).toBe("");
    expect(Object.values(lean.playbook.roles).every((role) => role.instructions === "")).toBe(true);
    expect(lean.playbook.steps.map((s) => s.id)).toEqual(run.playbook.steps.map((s) => s.id));
    // The run in the store is untouched.
    expect(run.steps.a!.attempts[0]!.prompt).toHaveLength(5000);
  });
});

describe("stepDetail and withDetail", () => {
  it("restores every deferred field, and never removes or invents an attempt", () => {
    const run = withAttempts();
    const detail = stepDetail(run, "a")!;
    expect(detail.step.prompt).toContain("Do the thing");
    expect(detail.role?.instructions).not.toBe("");
    const lean = leanRun(run);
    expect(withDetail(lean.steps.a!, detail.state).attempts).toEqual(run.steps.a!.attempts);
    // The list is newer: a third attempt it already has is kept (as lean), one the detail still has but the list lost is not shown.
    const newer = structuredClone(lean.steps.a!);
    newer.attempts.push(leanRun({ ...run, steps: { a: { ...run.steps.a!, attempts: [attempt(3)] } } }).steps.a!.attempts[0]!);
    expect(withDetail(newer, detail.state).attempts.map((a) => a.n)).toEqual([1, 2, 3]);
    expect(withDetail(lean.steps.a!, undefined)).toBe(lean.steps.a);
    // A report that arrived after the detail was fetched is not overwritten by the older detail without it.
    const stale = structuredClone(detail.state);
    stale.attempts[1]!.report = null;
    expect(withDetail(lean.steps.a!, stale).attempts[1]!.report).toEqual(lean.steps.a!.attempts[1]!.report);
  });
  it("is null for an unknown step", () => expect(stepDetail(base, "nope")).toBeNull());
});
