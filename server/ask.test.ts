import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook } from "../shared/types";
import { completeStep, decideGate, endTurn, newRun, readySteps, recordReport, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function load(files: Record<string, string>, id: string): Promise<{ playbook: Playbook | null; errors: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === id)!;
  return { playbook: entry.playbook, errors: entry.errors };
}

const PB = (on: string) => `
inputs: { request: { required: true } }
steps:
  - id: investigate
    role: investigator
    inputs: [request]
    outcomes: [success, needs_input]
    outputs: { plan: {} }
    on:
      needs_input: ${on}
  - id: implement
    role: implementer
    needs: [investigate]
    inputs: [request, plan]
    outputs: { pr_url: {} }
`;
const ASK = '{ ask: "The investigation needs your input.", max_loops: 2 }';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();

describe("on.<outcome>.ask", () => {
  it("opens an answer gate, then loops back to the step with the answer as feedback", async () => {
    const { playbook, errors } = await load({ "p.yaml": PB(ASK) }, "p");
    expect(errors).toEqual([]);
    expect(playbook!.steps[0]!.on.needs_input).toEqual({ kind: "ask", ask: "The investigation needs your input.", target: "investigate", maxLoops: 2 });
    const run = newRun({ id: "r", playbook: playbook!, workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "x" }, now: now() });

    // A needs_input report needs no outputs.
    startAttempt(run, "investigate", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    recordReport(run, "a1", { outcome: "needs_input", summary: "Which database?", outputs: {} }, now());
    endTurn(run, "a1", { turnEnd: "completed", lastMessage: null, now: now() });
    const fx = completeStep(run, "investigate", { outcome: "needs_input", now: now() });
    expect(fx.notes.join(" ")).toMatch(/needs input/);
    expect(run.status).toBe("waiting_gate");
    expect(run.steps.investigate!.status).toBe("waiting");
    expect(run.steps.implement!.status).toBe("pending");
    const gate = run.gates[0]!;
    expect(gate).toMatchObject({ kind: "ask", stepId: "investigate", status: "pending", summary: "The investigation needs your input.", details: "Which database?" });

    // The answer is required, and only "answered" is a choice.
    expect(() => decideGate(run, gate.id, { decision: "answered", comment: " ", by: null, via: "panel", now: now() })).toThrow(/needs a comment/);
    expect(() => decideGate(run, gate.id, { decision: "approved", comment: "x", by: null, via: "panel", now: now() })).toThrow(/not a choice/);
    decideGate(run, gate.id, { decision: "answered", comment: "Use postgres", by: null, via: "panel", now: now() });
    expect(run.status).toBe("running");
    expect(readySteps(run)).toEqual(["investigate"]);
    expect(run.steps.investigate!.feedback).toBe("Use postgres");
    expect(run.loops["investigate->investigate"]).toBe(1);

    // Second attempt gets the answer in its prompt and can finish normally.
    const started = startAttempt(run, "investigate", { agentId: "a2", brief: "", now: now(), readonlySnapshot: null });
    expect(started.prompt).toContain("Use postgres");
    recordReport(run, "a2", { outcome: "success", summary: "ok", outputs: { plan: "p" } }, now());
    endTurn(run, "a2", { turnEnd: "completed", lastMessage: null, now: now() });
    completeStep(run, "investigate", { outcome: "success", now: now() });
    expect(readySteps(run)).toEqual(["implement"]);
  });

  it("can go back to an earlier step, and stops at max_loops with a loop-limit gate", async () => {
    const { playbook, errors } = await load(
      {
        "p.yaml": `
inputs: { request: { required: true } }
steps:
  - id: investigate
    role: investigator
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: implementer
    needs: [investigate]
    inputs: [request, plan]
    outcomes: [success, needs_input]
    outputs: { pr_url: {} }
    on:
      needs_input: { ask: "Need a decision.", goto: investigate, max_loops: 1 }
`,
      },
      "p",
    );
    expect(errors).toEqual([]);
    const run = newRun({ id: "r", playbook: playbook!, workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "x" }, now: now() });
    const ask = (agent: string) => {
      startAttempt(run, "implement", { agentId: agent, brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, agent, { outcome: "needs_input", summary: "q", outputs: {} }, now());
      endTurn(run, agent, { turnEnd: "completed", lastMessage: null, now: now() });
      completeStep(run, "implement", { outcome: "needs_input", now: now() });
      decideGate(run, run.gates.at(-1)!.id, { decision: "answered", comment: "a", by: null, via: "panel", now: now() });
    };
    const pass = (stepId: string, agent: string, outputs: Record<string, string>) => {
      startAttempt(run, stepId, { agentId: agent, brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, agent, { outcome: "success", summary: "ok", outputs }, now());
      endTurn(run, agent, { turnEnd: "completed", lastMessage: null, now: now() });
      completeStep(run, stepId, { outcome: "success", now: now() });
    };
    pass("investigate", "i1", { plan: "p" });
    ask("x1");
    expect(readySteps(run)).toEqual(["investigate"]);
    pass("investigate", "i2", { plan: "p" });
    ask("x2");
    expect(run.gates.at(-1)!.kind).toBe("loop_limit");
    expect(run.status).toBe("waiting_gate");
  });

  it("is validated", async () => {
    const gateStep = `
steps:
  - id: g
    gate: ok?
    on:
      rejected: { ask: "why?" }
`;
    expect((await load({ "g.yaml": gateStep }, "g")).errors.join("\n")).toMatch(/`ask` only applies to an agent step/);
    const later = PB('{ ask: "q", goto: implement }');
    expect((await load({ "p.yaml": later }, "p")).errors.join("\n")).toMatch(/goto "implement" must point to an earlier step/);
    const unknown = PB('{ ask: "q", goto: nope }');
    expect((await load({ "p.yaml": unknown }, "p")).errors.join("\n")).toMatch(/goto unknown step "nope"/);
    const notOutcome = PB(ASK).replace("outcomes: [success, needs_input]", "outcomes: [success, other]").replace("needs_input:", "needs_input:");
    expect((await load({ "p.yaml": notOutcome }, "p")).errors.join("\n")).toMatch(/not an outcome of this step/);
  });

  it("works inside a sub-playbook (target is prefixed)", async () => {
    const { playbook, errors } = await load(
      { "pr.yaml": PB(ASK), "cap.yaml": "inputs: { request: { required: true } }\nsteps:\n  - id: pr\n    playbook: pr\n" },
      "cap",
    );
    expect(errors).toEqual([]);
    expect(playbook!.steps.find((step) => step.id === "pr.investigate")!.on.needs_input).toMatchObject({ kind: "ask", target: "pr.investigate" });
  });
});
