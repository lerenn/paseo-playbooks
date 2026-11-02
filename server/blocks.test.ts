import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { renderTemplate } from "../shared/vars";
import { completeStep, decideGate, newRun, readySteps, recordReport, requestGate, startAttempt, endTurn, stepInputs } from "./engine";
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
    role: investigator
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: implementer
    needs: [investigate]
    inputs: [request, plan, base_branch]
    outputs: { pr_url: {} }
  - id: babysit
    role: babysitter
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
    role: reviewer
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
    playbook: pr
  - id: approve
    needs: [pr]
    gate: Ship it?
    on:
      rejected: { goto: pr }
  - id: release
    needs: [approve]
    playbook: release
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
      "a.yaml": "steps:\n  - id: b\n    playbook: b\n",
      "b.yaml": "steps:\n  - id: a\n    playbook: a\n",
      "c.yaml": "steps:\n  - id: x\n    playbook: nope\n",
      "pr.yaml": PR,
      "d.yaml": "steps:\n  - id: pr\n    playbook: pr\n    inputs: { colour: blue }\n",
    });
    const entries = new Map((await loadPlaybooks(dir)).entries.map((entry) => [entry.id, entry]));
    expect(entries.get("a")!.errors.join("\n")).toMatch(/includes itself|is invalid/);
    expect(entries.get("b")!.errors.join("\n")).toMatch(/includes itself|is invalid/);
    expect(entries.get("c")!.errors.join("\n")).toMatch(/playbook "nope" not found/);
    expect(entries.get("d")!.errors.join("\n")).toMatch(/has no input "colour"/);
  });
});
