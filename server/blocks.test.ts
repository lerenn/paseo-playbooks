import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { renderTemplate } from "../shared/vars";
import { destinationOf } from "../shared/gates";
import { holdsBlock, planAdmissions, slotHolders } from "../shared/slots";
import { admitBlock, completeStep, decideGate, newRun, readySteps, recordReport, requestGate, startAttempt, endTurn, stepInputs } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "blocks-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return dir;
}

const PR = `
inputs:
  request: { required: true }
  base_branch: { default: main }
outputs:
  pr_url: {}
steps:
  - id: investigate
    role: { name: investigator }
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: { name: implementer }
    needs: [investigate]
    inputs: [request, plan, base_branch]
    outputs: { pr_url: {} }
  - id: babysit
    role: { name: babysitter }
    needs: [implement]
    inputs: [pr_url]
    outcomes: [ready, changes_requested]
    on:
      changes_requested: { goto: implement, max_loops: 2 }
`;
const RELEASE = `
title: Release
inputs:
  pr_url: { required: true }
outputs:
  env_url: {}
steps:
  - id: deploy
    role: { name: reviewer }
    inputs: [pr_url]
    outputs: { env_url: {} }
`;
const CAPABILITY = `
title: Capability
inputs:
  request: { required: true }
outputs:
  env_url: {}
steps:
  - id: pr
    playbook: { name: pr }
  - id: approve
    needs: [pr]
    gate: { question: Ship it? }
    on:
      rejected: { goto: pr }
  - id: release
    needs: [approve]
    playbook: { name: release }
`;

describe("sub-playbooks", () => {
  it("expands playbook steps into prefixed steps with rewired needs, inputs, outputs and gotos", async () => {
    const dir = await folder({ "pr.yaml": PR, "release.yaml": RELEASE, "capability.yaml": CAPABILITY });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "capability")!;
    expect(entry.errors).toEqual([]);
    const playbook = entry.playbook!;
    const byId = new Map(playbook.steps.map((step) => [step.id, step]));
    expect(playbook.steps.map((step) => step.id)).toEqual(["pr.investigate", "pr.implement", "pr.babysit", "approve", "release.deploy"]);
    expect(byId.get("pr.investigate")!.needs).toEqual([]);
    expect(byId.get("pr.implement")!.needs).toEqual(["pr.investigate"]);
    expect(byId.get("approve")!.needs).toEqual(["pr.babysit"]);
    expect(byId.get("release.deploy")!.needs).toEqual(["approve"]);
    // Parent input → sub input; sub default when the parent has nothing; inner step outputs prefixed.
    expect(byId.get("pr.investigate")!.inputs.request!.source).toBe("{{ playbook.inputs.request }}");
    expect(byId.get("pr.implement")!.inputs.base_branch!.source).toBe("main");
    expect(byId.get("pr.implement")!.inputs.plan!.source).toBe("{{ steps.pr.investigate.outputs.plan }}");
    // release's pr_url auto-matches pr's output, which is the inner implement step's output.
    expect(byId.get("release.deploy")!.inputs.pr_url!.source).toBe("{{ steps.pr.implement.outputs.pr_url }}");
    // Gotos: inner loop stays inside; a goto to the block targets its first step.
    expect(byId.get("pr.babysit")!.on.changes_requested).toMatchObject({ kind: "goto", target: "pr.implement", maxLoops: 2 });
    expect(byId.get("approve")!.on.rejected).toMatchObject({ kind: "goto", target: "pr.investigate" });
    expect(playbook.outputs.env_url!.source).toBe("{{ steps.release.deploy.outputs.env_url }}");
    expect(playbook.blocks).toEqual({ pr: { title: "pr", playbook: "pr" }, release: { title: "Release", playbook: "release" } });
    expect(playbook.roles.implementer).toBeDefined();
  });

  it("runs end to end: values flow through dotted ids, and a rejected gate restarts the block", async () => {
    const dir = await folder({ "pr.yaml": PR, "release.yaml": RELEASE, "capability.yaml": CAPABILITY });
    const playbook = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "capability")!.playbook!;
    let clock = 0;
    const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();
    const run: Run = newRun({ id: "run_b", playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "Add X" }, now: now() });
    const finish = (stepId: string, outcome: string, outputs: Record<string, string>) => {
      const agentId = `a-${stepId}-${clock}`;
      startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
      recordReport(run, agentId, { outcome, summary: "ok", outputs }, now());
      endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
      completeStep(run, stepId, { outcome, now: now() });
    };
    expect(readySteps(run)).toEqual(["pr.investigate"]);
    finish("pr.investigate", "success", { plan: "the plan" });
    expect(stepInputs(run, playbook.steps.find((step) => step.id === "pr.implement")!).plan!.value).toBe("the plan");
    finish("pr.implement", "success", { pr_url: "https://github.com/o/r/pull/9" });
    finish("pr.babysit", "ready", {});
    expect(readySteps(run)).toEqual(["approve"]);
    requestGate(run, "approve", "Ship it?", now());
    decideGate(run, "approve", { decision: "rejected", comment: "rename it", by: null, via: "panel", now: now() });
    expect(readySteps(run)).toEqual(["pr.investigate"]);
    expect(run.steps["pr.investigate"]!.feedback).toBe("rename it");
    expect(renderTemplate("{{ steps.pr.implement.outputs.pr_url }}", { steps: { "pr.implement": { outputs: { pr_url: "u" } } } })).toBe("u");
  });

  it("refuses self-inclusion, unknown playbooks and unknown block inputs", async () => {
    const dir = await folder({
      "a.yaml": "steps:\n  - id: b\n    playbook: { name: b }\n",
      "b.yaml": "steps:\n  - id: a\n    playbook: { name: a }\n",
      "c.yaml": "steps:\n  - id: x\n    playbook: { name: nope }\n",
      "pr.yaml": PR,
      "d.yaml": "steps:\n  - id: pr\n    playbook: { name: pr }\n    inputs: { colour: blue }\n",
    });
    const entries = new Map((await loadPlaybooks(dir)).entries.map((entry) => [entry.id, entry]));
    expect(entries.get("a")!.errors.join("\n")).toMatch(/includes itself|is invalid/);
    expect(entries.get("b")!.errors.join("\n")).toMatch(/includes itself|is invalid/);
    expect(entries.get("c")!.errors.join("\n")).toMatch(/playbook "nope" not found/);
    expect(entries.get("d")!.errors.join("\n")).toMatch(/has no input "colour"/);
  });

});

// A block that can stop early: `trivial` at triage, `enough` at deep, or a rejected wrap gate.
const CHECK = `
title: Check
concurrency: 1
inputs:
  request: { required: true }
outputs:
  verdict: {}
steps:
  - id: triage
    role: { name: investigator }
    inputs: [request]
    outcomes: [deep, trivial]
    on:
      trivial: end
  - id: deep
    role: { name: reviewer }
    needs: [triage]
    outputs: { verdict: {} }
    outcomes: [success, enough]
    on:
      enough: end
  - id: side
    role: { name: reviewer }
    needs: [triage]
  - id: wrap
    needs: [deep, side]
    gate: { question: Looks right? }
    on:
      rejected: end
`;
const OUTER = `
title: Outer
inputs:
  request: { required: true }
steps:
  - id: check
    playbook: { name: check }
  - id: tail
    role: { name: reviewer }
    needs: [check]
`;
const PARENT = `
inputs:
  request: { required: true }
outputs:
  verdict: {}
steps:
  - id: check
    playbook: { name: check }
  - id: after
    needs: [check]
    gate: { question: Done? }
    on:
      rejected: { goto: check }
`;
const NESTED = `
inputs:
  request: { required: true }
steps:
  - id: outer
    playbook: { name: outer }
  - id: last
    role: { name: reviewer }
    needs: [outer]
`;

describe("end inside a sub-playbook block", () => {
  async function start(id: string) {
    const dir = await folder({ "check.yaml": CHECK, "outer.yaml": OUTER, "parent.yaml": PARENT, "nested.yaml": NESTED });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === id)!;
    expect(entry.errors).toEqual([]);
    let clock = 0;
    const now = () => new Date(Date.UTC(2026, 10, 3, 12, 0, clock++)).toISOString();
    const run: Run = newRun({ id: `run_${id}`, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "R" }, now: now() });
    // What the runtime does after every change: admit queued blocks while slots are free.
    const admit = () => {
      for (const { prefix } of planAdmissions([run])) admitBlock(run, prefix, now());
    };
    const begin = (stepId: string) => {
      admit();
      const agentId = `a-${stepId}-${clock}`;
      startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
      return agentId;
    };
    const finish = (stepId: string, outcome: string, outputs: Record<string, string> = {}) => {
      const agentId = begin(stepId);
      recordReport(run, agentId, { outcome, summary: "ok", outputs }, now());
      endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
      return completeStep(run, stepId, { outcome, now: now() });
    };
    return { run, now, begin, finish };
  }

  it("at top level, end still completes the run", async () => {
    const { run, finish } = await start("check");
    finish("triage", "trivial");
    expect(run.status).toBe("completed");
    expect(run.steps.deep!.status).toBe("pending");
  });

  it("ends only the block: its other steps are skipped and the parent goes on", async () => {
    const { run, finish, now } = await start("parent");
    const fx = finish("check.triage", "trivial");
    expect(run.status).toBe("running");
    expect(run.steps["check.triage"]!.status).toBe("completed");
    for (const id of ["check.deep", "check.side", "check.wrap"]) expect(run.steps[id]!.status).toBe("skipped");
    expect(readySteps(run)).toEqual(["after"]);
    expect(fx.notes.join(" ")).toMatch(/ended block "check"/);
    // The block no longer holds its concurrency slot.
    expect(holdsBlock(run, "check")).toBe(false);
    expect(slotHolders([run], "p", "check")).toEqual([]);
    requestGate(run, "after", "Done?", now());
    decideGate(run, "after", { decision: "approved", comment: null, by: null, via: "panel", now: now() });
    expect(run.status).toBe("completed");
    // The block's outputs resolve as far as its completed steps go: deep never ran.
    expect(run.outputs).toEqual({});
  });

  it("cancels running steps of the block and closes their gates", async () => {
    const { run, finish, begin } = await start("parent");
    finish("check.triage", "deep");
    const side = begin("check.side");
    const fx = finish("check.deep", "enough", { verdict: "fine" });
    expect(fx.cancelAgents).toContain(side);
    expect(run.steps["check.side"]!.status).toBe("skipped");
    expect(run.steps["check.side"]!.attempts.at(-1)!.turnEnd).toBe("canceled");
    expect(run.steps["check.wrap"]!.status).toBe("skipped");
    expect(readySteps(run)).toEqual(["after"]);
  });

  it("works from a gate choice, and a goto to the ended block restarts it", async () => {
    const { run, finish, now } = await start("parent");
    finish("check.triage", "deep");
    finish("check.deep", "success", { verdict: "fine" });
    finish("check.side", "success");
    expect(destinationOf(run.playbook, run.playbook.steps.find((step) => step.id === "check.wrap")!, "rejected")).toEqual({ kind: "end_block", targets: ["check"] });
    requestGate(run, "check.wrap", "Looks right?", now());
    decideGate(run, "check.wrap", { decision: "rejected", comment: "stop here", by: null, via: "panel", now: now() });
    expect(run.steps["check.wrap"]!.status).toBe("completed");
    expect(readySteps(run)).toEqual(["after"]);
    // Now end at triage, then send the block round again from the parent's gate.
    requestGate(run, "after", "Done?", now());
    decideGate(run, "after", { decision: "rejected", comment: "again", by: null, via: "panel", now: now() });
    expect(run.status).toBe("running");
    expect(run.steps["check.triage"]!.status).toBe("queued");
    finish("check.triage", "trivial");
    expect(readySteps(run)).toEqual(["after"]);
    requestGate(run, "after", "Done?", now());
    decideGate(run, "after", { decision: "rejected", comment: "once more", by: null, via: "panel", now: now() });
    for (const id of ["check.deep", "check.side", "check.wrap"]) expect(run.steps[id]!.status).toBe("pending");
    // The ended block gave its slot back, so it queues for it again like any restart.
    expect(run.steps["check.triage"]!.status).toBe("queued");
  });

  it("in nested blocks, ends only the innermost one", async () => {
    const { run, finish } = await start("nested");
    finish("outer.check.triage", "trivial");
    for (const id of ["outer.check.deep", "outer.check.side", "outer.check.wrap"]) expect(run.steps[id]!.status).toBe("skipped");
    expect(readySteps(run)).toEqual(["outer.tail"]);
    expect(run.steps.last!.status).toBe("pending");
    finish("outer.tail", "success");
    expect(readySteps(run)).toEqual(["last"]);
    finish("last", "success");
    expect(run.status).toBe("completed");
  });
  it("resets a block's loop counters each time an outer loop re-enters it", async () => {
    const dir = await folder({
      "fix.yaml": "steps:\n  - id: qa\n    role: { name: reviewer }\n    outcomes: [pass, retry]\n    on:\n      retry: { goto: qa, max_loops: 2 }\n",
      "all.yaml": "steps:\n  - id: fix\n    playbook: { name: fix }\n  - id: next\n    needs: [fix]\n    role: { name: reviewer }\n    outcomes: [done, more]\n    on:\n      more: { goto: fix, max_loops: 2 }\n",
    });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "all")!;
    expect(entry.errors).toEqual([]);
    let clock = 0;
    const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();
    const r: Run = newRun({ id: "run_l", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
    const finish = (stepId: string, outcome: string) => {
      const agentId = `a-${stepId}-${clock}`;
      startAttempt(r, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
      recordReport(r, agentId, { outcome, summary: "ok", outputs: {} }, now());
      endTurn(r, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
      return completeStep(r, stepId, { outcome, now: now() });
    };
    const item = (last: boolean) => {
      finish("fix.qa", "retry");
      finish("fix.qa", "retry");
      finish("fix.qa", "pass");
      return finish("next", last ? "done" : "more");
    };
    item(false);
    expect(r.loops["fix.qa->fix.qa"]).toBeUndefined();
    expect(r.loops["next->fix.qa"]).toBe(1);
    item(false);
    item(true);
    expect(r.gates).toEqual([]);
    expect(r.status).toBe("completed");
    expect(r.loopTotals["fix.qa->fix.qa"]).toBe(6);
    expect(r.loopTotals["next->fix.qa"]).toBe(2);
  });

  it("still opens the outer loop-limit gate when the block is re-entered too often", async () => {
    const dir = await folder({
      "fix.yaml": "steps:\n  - id: qa\n    role: { name: reviewer }\n",
      "all.yaml": "steps:\n  - id: fix\n    playbook: { name: fix }\n  - id: next\n    needs: [fix]\n    role: { name: reviewer }\n    outcomes: [done, more]\n    on:\n      more: { goto: fix, max_loops: 2 }\n",
    });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "all")!;
    let clock = 0;
    const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();
    const r: Run = newRun({ id: "run_m", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
    const finish = (stepId: string, outcome: string) => {
      const agentId = `a-${stepId}-${clock}`;
      startAttempt(r, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
      recordReport(r, agentId, { outcome, summary: "ok", outputs: {} }, now());
      endTurn(r, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
      completeStep(r, stepId, { outcome, now: now() });
    };
    for (let i = 0; i < 3; i++) {
      finish("fix.qa", "success");
      finish("next", "more");
    }
    expect(r.gates.filter((gate) => gate.kind === "loop_limit")).toHaveLength(1);
    expect(r.status).toBe("waiting_gate");
  });

});
