import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import {
  cancelRun,
  completeStep,
  decideGate,
  endTurn,
  newRun,
  readySteps,
  recordReport,
  requestGate,
  startAttempt,
} from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
let playbook: Playbook;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();

beforeAll(async () => {
  const result = await loadPlaybooks(EXAMPLES, { allowedModes: { claude: ["default", "bypassPermissions"] } });
  playbook = result.entries.find((entry) => entry.id === "pr")!.playbook!;
});

function run(): Run {
  return newRun({
    id: "run_test",
    playbook,
    workspaceId: "ws",
    workspaceDir: "/tmp/ws",
    projectId: "proj",
    branch: "playbooks/pr-run_test",
    managerAgentId: "manager",
    inputs: { request: "Fix the flaky test" },
    now: now(),
  });
}

const OUTPUTS: Record<string, Record<string, unknown>> = {
  investigate: { plan: "Do the thing" },
  implement: { pr_url: "https://github.com/o/r/pull/7", pr_number: "7", branch: "playbooks/pr-run_test" },
  review: { findings: "No findings" },
  local_qa: { report: "all green", tests_passed: "true" },
  babysit: {},
};

/** Starts, reports and ends the turn of a step with the given outcome. */
function runStep(r: Run, stepId: string, outcome: string, agentId = `${stepId}-${Math.random()}`) {
  const started = startAttempt(r, stepId, { agentId, brief: `brief for ${stepId}`, now: now(), readonlySnapshot: null });
  recordReport(r, agentId, { outcome, summary: `${stepId} ${outcome}`, outputs: outcome === "failure" ? {} : OUTPUTS[stepId]! }, now());
  endTurn(r, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  return { started, fx: completeStep(r, stepId, { outcome, now: now() }) };
}

describe("engine", () => {
  it("applies input defaults and starts with the root ready", () => {
    const r = run();
    expect(r.inputs).toEqual({ request: "Fix the flaky test", base_branch: "main" });
    expect(readySteps(r)).toEqual(["investigate"]);
  });

  it("rejects missing required inputs", () => {
    expect(() =>
      newRun({ id: "x", playbook, workspaceId: "w", workspaceDir: "/", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() }),
    ).toThrow(/input "request" is required/);
  });

  it("runs the PR playbook to its gate and completes on approval", () => {
    const r = run();
    const { started } = runStep(r, "investigate", "success");
    expect(started.prompt).toContain("Request: Fix the flaky test");
    expect(readySteps(r)).toEqual(["implement"]);
    const impl = runStep(r, "implement", "success");
    expect(impl.started.prompt).toContain("Do the thing");
    expect(impl.started.attempt.inputs.plan).toEqual({ value: "Do the thing", source: "investigate.plan (auto)" });
    expect(r.steps.implement!.outputs.pr_number).toBe(7);
    expect(readySteps(r)).toEqual(["review", "local_qa"]);
    runStep(r, "review", "success");
    expect(readySteps(r)).toEqual(["local_qa"]);
    runStep(r, "local_qa", "success");
    expect(readySteps(r)).toEqual(["babysit"]);
    runStep(r, "babysit", "ready");
    expect(readySteps(r)).toEqual(["pr_approval"]);
    requestGate(r, "pr_approval", "PR green", now());
    expect(r.status).toBe("waiting_gate");
    const decided = decideGate(r, "pr_approval", { decision: "approved", comment: null, by: "host", via: "panel", now: now() });
    expect(decided.alreadyDecided).toBe(false);
    expect(r.status).toBe("completed");
    expect(r.outputs).toEqual({ pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    expect(decideGate(r, "pr_approval", { decision: "rejected", comment: null, by: null, via: "chat", now: now() }).alreadyDecided).toBe(true);
  });

  it("refuses a report with missing or mistyped outputs", () => {
    const r = run();
    startAttempt(r, "investigate", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    expect(() => recordReport(r, "a1", { outcome: "success", summary: "", outputs: {} }, now())).toThrow(/missing output "plan"/);
    expect(() => recordReport(r, "a1", { outcome: "nope", summary: "", outputs: {} }, now())).toThrow(/not allowed/);
  });

  it("refuses to start a step that is not ready", () => {
    const r = run();
    expect(() => startAttempt(r, "implement", { agentId: "x", brief: "", now: now(), readonlySnapshot: null })).toThrow(/pending, not ready/);
  });

  it("loops back with feedback and resets descendants", () => {
    const r = run();
    for (const id of ["investigate", "implement", "review", "local_qa"]) runStep(r, id, "success");
    const { fx } = runStep(r, "babysit", "changes_requested");
    expect(fx.notes.join(" ")).toMatch(/Looping back to "implement"/);
    expect(r.loops["babysit->implement"]).toBe(1);
    expect(readySteps(r)).toEqual(["implement"]);
    expect(r.steps.review!.status).toBe("pending");
    expect(r.steps.investigate!.status).toBe("completed");
    const again = startAttempt(r, "implement", { agentId: "impl-2", brief: "", now: now(), readonlySnapshot: null });
    expect(again.prompt).toContain("Feedback to address");
    expect(again.prompt).toContain("babysit changes_requested");
    expect(again.attempt.n).toBe(2);
  });

  it("opens a loop-limit gate after max_loops and honours the decision", () => {
    const r = run();
    runStep(r, "investigate", "success");
    for (let loop = 0; loop < 3; loop++) {
      for (const id of ["implement", "review", "local_qa"]) runStep(r, id, "success");
      runStep(r, "babysit", "changes_requested");
    }
    for (const id of ["implement", "review", "local_qa"]) runStep(r, id, "success");
    const { fx } = runStep(r, "babysit", "changes_requested");
    expect(fx.notes.join(" ")).toMatch(/Loop limit reached/);
    expect(r.status).toBe("waiting_gate");
    const gate = r.gates.find((g) => g.kind === "loop_limit")!;
    decideGate(r, gate.id, { decision: "approved", comment: null, by: "host", via: "panel", now: now() });
    expect(r.loops["babysit->implement"]).toBe(4);
    expect(readySteps(r)).toEqual(["implement"]);
    for (const id of ["implement", "review", "local_qa"]) runStep(r, id, "success");
    runStep(r, "babysit", "changes_requested");
    const second = r.gates.filter((g) => g.kind === "loop_limit").at(-1)!;
    decideGate(r, second.id, { decision: "rejected", comment: "enough", by: "host", via: "panel", now: now() });
    expect(r.status).toBe("failed");
  });

  it("retries a failure within retries, then fails; lost attempts don't count", () => {
    const r = run();
    runStep(r, "investigate", "success");
    startAttempt(r, "implement", { agentId: "lost", brief: "", now: now(), readonlySnapshot: null });
    endTurn(r, "lost", { turnEnd: "lost", lastMessage: "…", now: now() });
    completeStep(r, "implement", { outcome: "failure", now: now() });
    expect(readySteps(r)).toEqual(["implement"]);
    runStep(r, "implement", "failure");
    expect(readySteps(r)).toEqual(["implement"]);
    runStep(r, "implement", "failure");
    expect(r.status).toBe("failed");
    expect(r.failure).toMatch(/failed after 2 attempt/);
  });

  it("gate rejection loops back to implement", () => {
    const r = run();
    for (const id of ["investigate", "implement", "review", "local_qa"]) runStep(r, id, "success");
    runStep(r, "babysit", "ready");
    requestGate(r, "pr_approval", "", now());
    decideGate(r, "pr_approval", { decision: "rejected", comment: "rename the flag", by: "host", via: "panel", now: now() });
    expect(r.status).toBe("running");
    expect(r.steps.implement!.feedback).toBe("rename the flag");
    expect(readySteps(r)).toEqual(["implement"]);
  });

  it("cancels running agents when the run is canceled", () => {
    const r = run();
    startAttempt(r, "investigate", { agentId: "inv", brief: "", now: now(), readonlySnapshot: null });
    const fx = cancelRun(r, "user", now());
    expect(fx.cancelAgents).toEqual(["inv"]);
    expect(r.status).toBe("canceled");
  });
});
