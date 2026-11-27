import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook } from "../shared/types";
import { ASK_REPORT_SUMMARY_MAX, askReportSummary, choicesOfGate } from "../shared/gates";
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
    role: { name: investigator }
    inputs: [request]
    outcomes: [success, needs_input]
    outputs: { plan: {} }
    on:
      needs_input: ${on}
  - id: implement
    role: { name: implementer }
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
    role: { name: investigator }
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: { name: implementer }
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
    gate: { question: ok? }
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

  it("offers several choices, each going to its own step with the comment as feedback", async () => {
    const yaml = `
inputs: { request: { required: true } }
steps:
  - id: investigate
    role: { name: investigator }
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: { name: implementer }
    needs: [investigate]
    inputs: [request, plan]
    outcomes: [success, blocked]
    outputs: { pr_url: {} }
    on:
      blocked:
        ask: "Implementation is blocked."
        max_loops: 2
        choices:
          answered: {}
          replan: { goto: investigate, label: "Re-plan", max_loops: 1 }
          skip: { comment: none, color: warning }
`;
    const { playbook, errors } = await load({ "p.yaml": yaml }, "p");
    expect(errors).toEqual([]);
    expect(playbook!.steps[1]!.on.blocked).toEqual({
      kind: "ask",
      ask: "Implementation is blocked.",
      target: "implement",
      maxLoops: 2,
      choices: [
        { id: "answered", label: "Answered", comment: "required", target: "implement", maxLoops: 2 },
        { id: "replan", label: "Re-plan", comment: "required", target: "investigate", maxLoops: 1 },
        { id: "skip", label: "Skip", comment: "none", color: "warning", target: "implement", maxLoops: 2 },
      ],
    });
    const run = newRun({ id: "r", playbook: playbook!, workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "x" }, now: now() });
    const step = (stepId: string, agent: string, outcome: string, outputs: Record<string, string>) => {
      startAttempt(run, stepId, { agentId: agent, brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, agent, { outcome, summary: "s", outputs }, now());
      endTurn(run, agent, { turnEnd: "completed", lastMessage: null, now: now() });
      return completeStep(run, stepId, { outcome, now: now() });
    };
    step("investigate", "i1", "success", { plan: "p" });
    const fx = step("implement", "x1", "blocked", {});
    expect(fx.notes.join(" ")).toContain('"replan" (Re-plan, needs a comment)');
    const gate = run.gates.at(-1)!;
    expect(gate).toMatchObject({ kind: "ask", outcome: "blocked", gotoTarget: "implement" });
    expect(choicesOfGate(gate, playbook!.steps[1]).map((choice) => choice.id)).toEqual(["answered", "replan", "skip"]);
    expect(() => decideGate(run, gate.id, { decision: "replan", comment: "", by: null, via: "panel", now: now() })).toThrow(/needs a comment/);

    // The chosen choice's goto, with the choice and the comment as feedback.
    decideGate(run, gate.id, { decision: "replan", comment: "Split the migration", by: null, via: "panel", now: now() });
    expect(readySteps(run)).toEqual(["investigate"]);
    expect(run.steps.investigate!.feedback).toBe('The human answered "replan": Split the migration');
    expect(run.loops["implement->investigate"]).toBe(1);

    // A choice without a comment goes back to the step itself.
    step("investigate", "i2", "success", { plan: "p" });
    step("implement", "x2", "blocked", {});
    decideGate(run, run.gates.at(-1)!.id, { decision: "skip", comment: null, by: null, via: "chat", now: now() });
    expect(readySteps(run)).toEqual(["implement"]);
    expect(run.steps.implement!.feedback).toBe('The human answered "skip".');

    // Each choice keeps its own max_loops.
    step("implement", "x3", "blocked", {});
    decideGate(run, run.gates.at(-1)!.id, { decision: "replan", comment: "again", by: null, via: "panel", now: now() });
    expect(run.gates.at(-1)!).toMatchObject({ kind: "loop_limit", gotoTarget: "investigate" });
  });

  it("can end the asking step with another outcome and outputs, without running it again", async () => {
    const yaml = `
inputs: { request: { required: true } }
steps:
  - id: qa
    role: { name: investigator }
    inputs: [request]
    outcomes: [success, unverified, stop]
    outputs: { report: {}, passed: { type: boolean }, accepted: {} }
    on:
      stop: fail
      unverified:
        ask: "Some criteria are unverified."
        choices:
          continue: { outcome: success, comment: optional, outputs: { passed: true, accepted: "{{ gate.choice }} for {{ inputs.request }}: {{ gate.comment }}" } }
          answered: {}
          stop: { outcome: stop, comment: none }
  - id: next
    role: { name: implementer }
    needs: [qa]
    inputs: [report, accepted]
    outputs: { pr_url: {} }
`;
    const { playbook, errors } = await load({ "p.yaml": yaml }, "p");
    expect(errors).toEqual([]);
    const on = playbook!.steps[0]!.on.unverified!;
    expect(on.kind === "ask" && on.choices![0]).toEqual({
      id: "continue",
      label: "Continue",
      comment: "optional",
      target: "qa",
      outcome: "success",
      outputs: { passed: "true", accepted: "{{ gate.choice }} for {{ inputs.request }}: {{ gate.comment }}" },
    });
    const start = () => {
      const run = newRun({ id: "r", playbook: playbook!, workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "x" }, now: now() });
      startAttempt(run, "qa", { agentId: "q1", brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, "q1", { outcome: "unverified", summary: "2 criteria unverified", outputs: { report: "the report" } }, now());
      endTurn(run, "q1", { turnEnd: "completed", lastMessage: null, now: now() });
      completeStep(run, "qa", { outcome: "unverified", now: now() });
      return run;
    };

    const run = start();
    const gate = run.gates.at(-1)!;
    const fx = decideGate(run, gate.id, { decision: "continue", comment: "fine for now", by: null, via: "panel", now: now() });
    expect(fx.effects.notes.join(" ")).toMatch(/ends with "success" without running again/);
    expect(gate.status).toBe("continue");
    expect(run.steps.qa!.status).toBe("completed");
    expect(run.steps.qa!.attempts).toHaveLength(1);
    expect(run.steps.qa!.attempts[0]!.outcome).toBe("success");
    expect(run.steps.qa!.outputs).toEqual({ report: "the report", passed: true, accepted: "continue for x: fine for now" });
    expect(run.loops).toEqual({});
    expect(readySteps(run)).toEqual(["next"]);

    // Another outcome follows its own `on`.
    const stopped = start();
    decideGate(stopped, stopped.gates.at(-1)!.id, { decision: "stop", comment: null, by: null, via: "chat", now: now() });
    expect(stopped.status).toBe("failed");
    expect(stopped.steps.qa!.status).toBe("failed");

    // Outputs the report and the choice do not give refuse the decision; the gate stays open.
    const missing = start();
    missing.steps.qa!.attempts[0]!.report!.outputs = {};
    const pending = missing.gates.at(-1)!;
    expect(() => decideGate(missing, pending.id, { decision: "continue", comment: "", by: null, via: "panel", now: now() })).toThrow(/missing output "report"/);
    expect(pending.status).toBe("pending");
    expect(missing.steps.qa!.status).toBe("waiting");
  });

  it("validates ask choices that end the step", async () => {
    const pb = (choice: string, extra = "") => `
steps:
  - id: qa
    role: { name: investigator }
    outcomes: [success, unverified${extra}]
    outputs: { report: {} }
    on:
      unverified: { ask: "q", choices: { go: ${choice} } }
`;
    const errorsOf = async (yaml: string) => (await load({ "p.yaml": yaml }, "p")).errors.join("\n");
    expect(await errorsOf(pb("{ outcome: nope }"))).toMatch(/choices\.go: outcome "nope" is not an outcome of this step/);
    expect(await errorsOf(pb("{ outcome: unverified }"))).toMatch(/outcome "unverified" asks again/);
    expect(await errorsOf(pb("{ outcome: success, goto: qa }"))).toMatch(/`outcome` ends the step, so `goto` and `max_loops` do not apply/);
    expect(await errorsOf(pb("{ outputs: { report: x } }"))).toMatch(/`outputs` needs an `outcome`/);
    expect(await errorsOf(pb("{ outcome: success, outputs: { other: x } }"))).toMatch(/outputs\.other: not an output of this step \(report\)/);
    expect(await errorsOf(pb('{ outcome: success, outputs: { report: "{{ steps.x.outputs.y }}" } }'))).toMatch(/outputs\.report uses "\{\{ steps\.x\.outputs\.y \}\}"/);
    expect(await errorsOf(pb('{ outcome: success, outputs: { report: "{{ inputs.request }}" } }'))).toMatch(/uses "\{\{ inputs\.request \}\}"/);
    expect(await errorsOf(pb('{ outcome: success, outputs: { report: "{{ report.outputs.report }} / {{ report.summary }} / {{ gate.comment }}" } }'))).toBe("");
  });

  it("validates ask choices", async () => {
    const withChoices = (choices: string) => PB(`{ ask: "q", choices: ${choices} }`);
    expect((await load({ "p.yaml": withChoices("{}") }, "p")).errors.join("\n")).toMatch(/choices: declare at least one choice/);
    expect((await load({ "p.yaml": withChoices("{ Bad: {} }") }, "p")).errors.join("\n")).toMatch(/choices\.Bad: invalid name/);
    expect((await load({ "p.yaml": withChoices("{ go: { goto: nope } }") }, "p")).errors.join("\n")).toMatch(/on\.needs_input\.choices\.go: goto unknown step "nope"/);
    expect((await load({ "p.yaml": withChoices("{ go: { goto: implement } }") }, "p")).errors.join("\n")).toMatch(/goto "implement" must point to an earlier step/);
  });

  it("works inside a sub-playbook (target is prefixed)", async () => {
    const { playbook, errors } = await load(
      { "pr.yaml": PB(ASK), "cap.yaml": "inputs: { request: { required: true } }\nsteps:\n  - id: pr\n    playbook: { name: pr }\n" },
      "cap",
    );
    expect(errors).toEqual([]);
    expect(playbook!.steps.find((step) => step.id === "pr.investigate")!.on.needs_input).toMatchObject({ kind: "ask", target: "pr.investigate" });
  });

  it("prefixes ask choice targets inside a sub-playbook", async () => {
    const pr = PB('{ ask: "q", choices: { answered: {}, other: { comment: optional } } }');
    const { playbook, errors } = await load({ "pr.yaml": pr, "cap.yaml": "inputs: { request: { required: true } }\nsteps:\n  - id: pr\n    playbook: { name: pr }\n" }, "cap");
    expect(errors).toEqual([]);
    const on = playbook!.steps.find((step) => step.id === "pr.investigate")!.on.needs_input!;
    expect(on.kind === "ask" && on.choices!.map((choice) => choice.target)).toEqual(["pr.investigate", "pr.investigate"]);
  });
});

describe("{{ report.summary }} in an ask text", () => {
  const SUMMARY_ASK = '{ ask: "Needs input: {{ report.summary }}", max_loops: 2 }';
  const askWith = async (summary: string | undefined) => {
    const { playbook, errors } = await load({ "p.yaml": PB(SUMMARY_ASK) }, "p");
    expect(errors).toEqual([]);
    const run = newRun({ id: "r", playbook: playbook!, workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "x" }, now: now() });
    startAttempt(run, "investigate", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    if (summary !== undefined) recordReport(run, "a1", { outcome: "needs_input", summary, outputs: {} }, now());
    endTurn(run, "a1", { turnEnd: "completed", lastMessage: null, now: now() });
    completeStep(run, "investigate", { outcome: "needs_input", now: now() });
    return run.gates.at(-1)!;
  };

  const long = "Which database should the service use? ".repeat(20).trim();
  const cases: Array<[string, string | undefined, string]> = [
    ["a one-line question", "Which database: postgres or sqlite? Recommended: postgres.", "Needs input: Which database: postgres or sqlite? Recommended: postgres."],
    ["the first line of a multi-line report", "Which database?\n\nChoices: postgres, sqlite.\nEvidence: …", "Needs input: Which database?"],
    ["the first non-blank line, CRLF and indentation", "\r\n   \r\n  Merge PR #3 or wait for CI?  \r\nmore", "Needs input: Merge PR #3 or wait for CI?"],
    ["a Unicode line separator", "Ship it?\u2028details", "Needs input: Ship it?"],
    ["unicode kept whole", "Déployer 🚀 maintenant ? 中文", "Needs input: Déployer 🚀 maintenant ? 中文"],
    ["template text in the report, not expanded", "Use {{ playbook.inputs.request }}?", "Needs input: Use {{ playbook.inputs.request }}?"],
    ["a blank report", "   \n\t\n", "Needs input: (none)"],
    ["no report at all", undefined, "Needs input: (none)"],
    ["a long line, cut with an ellipsis", long, `Needs input: ${long.slice(0, 299).trimEnd()}…`],
  ];
  it.each(cases)("renders %s", async (_name, summary, expected) => {
    const gate = await askWith(summary);
    expect(gate.summary).toBe(expected);
    expect(gate.message.startsWith(expected)).toBe(true);
    // The full report stays in the gate's details.
    if (summary?.trim()) expect(gate.details).toBe(summary);
  });

  it("caps at ASK_REPORT_SUMMARY_MAX characters without splitting a character", () => {
    expect(askReportSummary("a".repeat(ASK_REPORT_SUMMARY_MAX))).toBe("a".repeat(ASK_REPORT_SUMMARY_MAX));
    const cut = askReportSummary("🚀".repeat(ASK_REPORT_SUMMARY_MAX + 1));
    expect(Array.from(cut)).toHaveLength(ASK_REPORT_SUMMARY_MAX);
    expect(cut).toBe(`${"🚀".repeat(ASK_REPORT_SUMMARY_MAX - 1)}…`);
    for (const value of [null, undefined, 42, {}, ["q"], ""]) expect(askReportSummary(value)).toBe("");
  });

  it("is accepted in an ask text only", async () => {
    const errorsOf = async (yaml: string) => (await load({ "p.yaml": yaml }, "p")).errors.join("\n");
    expect(await errorsOf(PB(SUMMARY_ASK))).toBe("");
    expect(await errorsOf(PB('{ ask: "{{ report.summary }}", choices: { answered: {} } }'))).toBe("");
    const gateQuestion = `
steps:
  - id: g
    gate: { question: "Ship {{ report.summary }}?" }
`;
    expect(await errorsOf(gateQuestion)).toMatch(/gate\.question: "\{\{ report\.summary \}\}" must be playbook\.inputs\.<name> or steps\.<id>\.outputs\.<name>$/m);
    expect(await errorsOf(PB('{ ask: "{{ report.outputs.plan }}" }'))).toMatch(/on\.needs_input\.ask: "\{\{ report\.outputs\.plan \}\}" must be .* \(or report\.summary\)/);
    expect(await errorsOf(PB('{ ask: "{{ report.summaryx }}" }'))).toMatch(/"\{\{ report\.summaryx \}\}" must be/);
  });

  it("keeps working inside a sub-playbook", async () => {
    const { playbook, errors } = await load(
      { "pr.yaml": PB(SUMMARY_ASK), "cap.yaml": "inputs: { request: { required: true } }\nsteps:\n  - id: pr\n    playbook: { name: pr }\n" },
      "cap",
    );
    expect(errors).toEqual([]);
    expect(playbook!.steps.find((step) => step.id === "pr.investigate")!.on.needs_input).toMatchObject({ kind: "ask", ask: "Needs input: {{ report.summary }}" });
  });
});
