import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import {
  currentAttempt,
  cancelRun,
  completeStep,
  decideGate,
  endTurn,
  newRun,
  pauseRun,
  readySteps,
  recordReport,
  requestGate,
  resumeRun,
  startAttempt,
} from "./engine";
import { isPaused } from "../shared/types";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
let playbook: Playbook;
/** The example Capability playbook: the PR playbook as a block, a gate, then the Release block. */
let capability: Playbook;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();

beforeAll(async () => {
  const result = await loadPlaybooks(EXAMPLES);
  playbook = result.entries.find((entry) => entry.id === "pr")!.playbook!;
  capability = result.entries.find((entry) => entry.id === "capability")!.playbook!;
});

function run(from: Playbook = playbook): Run {
  return newRun({
    id: "run_test",
    playbook: from,
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
  release: { env_url: "https://dev.example.com", log: "deployed" },
};

/** A Capability run with the whole pr block done, so the "approve" gate is ready. */
function capabilityAtGate(): Run {
  const r = run(capability);
  for (const id of ["pr.investigate", "pr.implement", "pr.review", "pr.local_qa"]) runStep(r, id, "success");
  runStep(r, "pr.babysit", "ready");
  return r;
}

/** Starts, reports and ends the turn of a step with the given outcome. */
function runStep(r: Run, stepId: string, outcome: string, agentId = `${stepId}-${Math.random()}`) {
  const started = startAttempt(r, stepId, { agentId, brief: `brief for ${stepId}`, now: now(), readonlySnapshot: null });
  recordReport(r, agentId, { outcome, summary: `${stepId} ${outcome}`, outputs: outcome === "failure" ? {} : OUTPUTS[stepId.slice(stepId.lastIndexOf(".") + 1)]! }, now());
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
    expect(r.status).toBe("completed");
    expect(r.outputs).toEqual({ pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
  });

  it("opens a gate with a summary and details; the first decision wins", () => {
    const r = capabilityAtGate();
    expect(readySteps(r)).toEqual(["approve"]);
    const gate = requestGate(r, "approve", "PR green", now(), "CI passed; link: https://github.com/o/r/pull/7");
    expect(r.status).toBe("waiting_gate");
    expect(gate.summary).toBe("PR green");
    expect(gate.details).toContain("CI passed");
    expect(gate.message.startsWith("PR green")).toBe(true);
    const decided = decideGate(r, "approve", { decision: "approved", comment: null, by: "host", via: "panel", now: now() });
    expect(decided.alreadyDecided).toBe(false);
    expect(r.status).toBe("running");
    expect(readySteps(r)).toEqual(["release.release"]);
    expect(decideGate(r, "approve", { decision: "rejected", comment: "x", by: null, via: "chat", now: now() }).alreadyDecided).toBe(true);
  });

  it("refuses a report with missing or mistyped outputs", () => {
    const r = run();
    startAttempt(r, "investigate", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    expect(() => recordReport(r, "a1", { outcome: "success", summary: "", outputs: {} }, now())).toThrow(/missing output "plan"/);
    expect(() => recordReport(r, "a1", { outcome: "nope", summary: "", outputs: {} }, now())).toThrow(/not allowed/);
  });

  it("does not require declared outputs on a failure report or its completion", () => {
    const r = run();
    startAttempt(r, "investigate", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    recordReport(r, "a1", { outcome: "failure", summary: "broke", outputs: { plan: "partial", bogus: 1 } }, now());
    expect(currentAttempt(r, "investigate")!.report).toEqual({ outcome: "failure", summary: "broke", outputs: { plan: "partial" } });
    expect(() => completeStep(r, "investigate", { outcome: "failure", now: now() })).not.toThrow();
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

  it("refuses unknown choices and a missing required comment", () => {
    const r = capabilityAtGate();
    requestGate(r, "approve", "", now());
    expect(() => decideGate(r, "approve", { decision: "maybe", comment: null, by: null, via: "panel", now: now() })).toThrow(/not a choice/);
    expect(() => decideGate(r, "approve", { decision: "rejected", comment: "  ", by: null, via: "panel", now: now() })).toThrow(/needs a comment/);
    expect(r.gates[0]!.status).toBe("pending");
  });

  it("gate rejection restarts the pr block with the comment as feedback", () => {
    const r = capabilityAtGate();
    requestGate(r, "approve", "", now());
    decideGate(r, "approve", { decision: "rejected", comment: "rename the flag", by: "host", via: "panel", now: now() });
    expect(r.status).toBe("running");
    expect(r.steps["pr.investigate"]!.feedback).toBe("rename the flag");
    expect(readySteps(r)).toEqual(["pr.investigate"]);
  });

  it("cancels running agents when the run is canceled", () => {
    const r = run();
    startAttempt(r, "investigate", { agentId: "inv", brief: "", now: now(), readonlySnapshot: null });
    const fx = cancelRun(r, "user", now());
    expect(fx.cancelAgents).toEqual(["inv"]);
    expect(r.status).toBe("canceled");
  });

  it("pauses by draining: running steps report, nothing starts until resume", () => {
    const r = run();
    runStep(r, "investigate", "success");
    runStep(r, "implement", "success");
    startAttempt(r, "review", { agentId: "rev", brief: "", now: now(), readonlySnapshot: null });
    expect(pauseRun(r, now())).toBe(true);
    expect(pauseRun(r, now())).toBe(false);
    expect(isPaused(r)).toBe(true);
    expect(() => startAttempt(r, "local_qa", { agentId: "qa", brief: "", now: now(), readonlySnapshot: null })).toThrow(/paused by a human/);
    // The running step still reports and is completed: only new starts are held.
    recordReport(r, "rev", { outcome: "success", summary: "ok", outputs: OUTPUTS.review! }, now());
    endTurn(r, "rev", { turnEnd: "completed", lastMessage: null, now: now() });
    completeStep(r, "review", { outcome: "success", now: now() });
    expect(readySteps(r)).toEqual(["local_qa"]);
    expect(resumeRun(r, now())).toBe(true);
    expect(resumeRun(r, now())).toBe(false);
    runStep(r, "local_qa", "success");
    expect(r.history.map((event) => event.type)).toEqual(expect.arrayContaining(["run_paused", "run_resumed"]));
  });

  it("refuses to pause an ended run, and canceling clears the pause", () => {
    const r = run();
    pauseRun(r, now());
    cancelRun(r, "user", now());
    expect(r.pausedAt).toBeNull();
    expect(() => pauseRun(r, now())).toThrow(/only an active run can be paused/);
  });
});
