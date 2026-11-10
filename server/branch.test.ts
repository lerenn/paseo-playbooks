import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { completeStep, endTurn, newRun, readySteps, recordReport, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 10, 12, 0, clock++)).toISOString();

async function load(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "branch-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  return (await loadPlaybooks(dir)).entries;
}

async function errorsOf(files: Record<string, string>, id = "b"): Promise<string> {
  return ((await load(files)).find((entry) => entry.id === id)?.errors ?? []).join("\n");
}

async function playbookOf(files: Record<string, string>, id = "b"): Promise<Playbook> {
  const entry = (await load(files)).find((candidate) => candidate.id === id)!;
  expect(entry.errors).toEqual([]);
  return entry.playbook!;
}

function start(playbook: Playbook, inputs: Record<string, unknown> = {}): Run {
  return newRun({ id: "run_b", playbook, workspaceId: "ws", workspaceDir: "/tmp/ws", projectId: "p", branch: "b", managerAgentId: "m", inputs, now: now() } as never);
}

function report(run: Run, stepId: string, outputs: Record<string, unknown>, outcome = "success") {
  const agentId = `${stepId}-agent`;
  startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
  recordReport(run, agentId, { outcome, summary: "done", outputs }, now());
  endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  completeStep(run, stepId, { outcome, now: now() });
}

const status = (run: Run, id: string) => run.steps[id]!.status;

const ROUTED = `
title: B
inputs:
  env: { type: enum, values: [dev, prd], default: dev }
steps:
  - id: scan
    role: { name: reviewer }
    outputs:
      kind: { type: enum, values: [service, infra, docs] }
      repos: { type: string }
  - id: opt
    needs: [scan]
    when: { env: prd }
    role: { name: reviewer }
    outputs: { url: {} }
  - id: route
    needs: [scan, opt]
    branch:
      cases:
        - { name: service, if: { steps.scan.outputs.kind: service } }
        - { name: infra, if: { steps.scan.outputs.kind: [infra, docs], env: prd } }
        - { name: unset, if: { steps.opt.outputs.url: { empty: true } } }
        - { name: other }
  - id: train
    needs: [route]
    when: { steps.route.outcome: service }
    role: { name: reviewer }
  - id: apply
    needs: [route]
    when: { steps.route.outcome: infra }
    role: { name: reviewer }
  - id: nothing
    needs: [route]
    when: { steps.route.outcome: [unset, other] }
    role: { name: reviewer }
  - id: done
    needs: [train, apply, nothing]
    gate: { question: Done? }
`;

describe("branch steps: validation", () => {
  it("refuses a branch without an else, and cases after the else", async () => {
    const missing = await errorsOf({
      "b.yaml": `
title: B
inputs: { env: { type: string, required: true } }
steps:
  - id: route
    branch: { cases: [{ name: a, if: { env: x } }, { name: b, if: { env: y } }] }
`,
    });
    expect(missing).toMatch(/branch has no else/);
    const after = await errorsOf({
      "b.yaml": `
title: B
inputs: { env: { type: string, required: true } }
steps:
  - id: route
    branch: { cases: [{ name: a }, { name: b, if: { env: y } }] }
`,
    });
    expect(after).toMatch(/"a" has no `if`, so it is the else and must be the last case/);
  });

  it("refuses an unreachable case, a duplicate name and an empty if", async () => {
    const errors = await errorsOf({
      "b.yaml": `
title: B
inputs: { env: { type: enum, values: [dev, stg, prd], required: true }, fast: { type: boolean, default: false } }
steps:
  - id: route
    branch:
      cases:
        - { name: any, if: { env: [dev, stg] } }
        - { name: narrower, if: { env: dev, fast: true } }
        - { name: same, if: { env: [dev, stg] } }
        - { name: any, if: {} }
        - { name: other }
`,
    });
    expect(errors).toMatch(/case "narrower" is unreachable: .* earlier case "any"/);
    expect(errors).toMatch(/case "same" is unreachable/);
    expect(errors).toMatch(/duplicate case name "any"/);
    expect(errors).toMatch(/`if` is empty/);
  });

  it("refuses unknown steps, outputs, outcomes and values, and steps that do not come before", async () => {
    const errors = await errorsOf({
      "b.yaml": `
title: B
steps:
  - id: scan
    role: { name: reviewer }
    outputs: { kind: { type: enum, values: [a, b] } }
  - id: other
    role: { name: reviewer }
  - id: route
    needs: [scan]
    branch:
      cases:
        - { name: a, if: { steps.ghost.outputs.x: 1 } }
        - { name: b, if: { steps.scan.outputs.nope: 1 } }
        - { name: c, if: { steps.scan.outputs.kind: zzz } }
        - { name: d, if: { steps.scan.outcome: maybe } }
        - { name: e, if: { steps.other.outputs.x: 1 } }
        - { name: g }
  - id: late
    needs: [route]
    role: { name: reviewer }
    when: { steps.later.outcome: success }
  - id: later
    needs: [late]
    role: { name: reviewer }
`,
    });
    expect(errors).toMatch(/unknown step "ghost"/);
    expect(errors).toMatch(/step "scan" has no output "nope"/);
    expect(errors).toMatch(/"zzz": expected one of a, b/);
    expect(errors).toMatch(/"maybe" is not an outcome of step "scan"/);
    expect(errors).toMatch(/step "other" is not one this step needs/);
    expect(errors).toMatch(/step "later" is not one this step needs/);
  });

  it("refuses fields that do not apply to a branch, and a member that tests an outcome that is not a case", async () => {
    const fields = await errorsOf({
      "b.yaml": `
title: B
inputs: { env: { type: string, default: x } }
steps:
  - id: route
    outputs: { x: {} }
    branch: { cases: [{ name: a, if: { nope: 1 } }, { name: b }] }
`,
    });
    expect(fields).toMatch(/`outputs` does not apply to a branch step/);
    expect(fields).toMatch(/if.nope: not an input of this playbook/);
    const member = await errorsOf({
      "b.yaml": `
title: B
steps:
  - id: route
    branch: { cases: [{ name: a }] }
  - id: member
    needs: [route]
    when: { steps.route.outcome: zzz }
    gate: { question: Go? }
`,
    });
    expect(member).toMatch(/"zzz" is not an outcome of step "route" \(a\)/);
  });
});

describe("branch steps: runtime", () => {
  it("runs only the matching case, in order, and lets the join go on", async () => {
    const playbook = await playbookOf({ "b.yaml": ROUTED });
    const service = start(playbook);
    report(service, "scan", { kind: "service", repos: "api" });
    expect(status(service, "route")).toBe("completed");
    expect(service.steps.route!.branch).toBe("service");
    expect(readySteps(service)).toEqual(["train"]);
    expect(status(service, "apply")).toBe("skipped");
    expect(status(service, "nothing")).toBe("skipped");
    expect(service.history.find((event) => event.type === "step_skipped" && event.stepId === "apply")?.detail).toBe("when: steps.route.outcome is service, not infra");

    // `infra` also needs env=prd: in dev it falls through, and the skipped `opt` left its output empty.
    const dev = start(playbook);
    report(dev, "scan", { kind: "infra", repos: "tf-github" });
    expect(dev.steps.route!.branch).toBe("unset");
    expect(dev.steps.route!.summary).toBe("steps.opt.outputs.url is empty");
    expect(readySteps(dev)).toEqual(["nothing"]);

    const prd = start(playbook, { env: "prd" });
    report(prd, "scan", { kind: "docs", repos: "tf-github" });
    expect(status(prd, "route")).toBe("pending");
    report(prd, "opt", { url: "https://x" });
    expect(prd.steps.route!.branch).toBe("infra");
    expect(readySteps(prd)).toEqual(["apply"]);
  });

  it("completes the join once the one branch that ran is done; skipped branches do not block it", async () => {
    const playbook = await playbookOf({ "b.yaml": ROUTED });
    const run = start(playbook);
    report(run, "scan", { kind: "service", repos: "api" });
    expect(status(run, "done")).toBe("pending");
    report(run, "train", {});
    expect(status(run, "done")).toBe("ready");
  });

  it("branches on inputs alone, and a branch inside a sub-playbook reads its own steps", async () => {
    const files = {
      "inner.yaml": `
title: Inner
hidden: true
inputs: { mode: { type: enum, values: [fast, slow], required: true } }
steps:
  - id: route
    branch: { cases: [{ name: quick, if: { mode: fast } }, { name: careful }] }
  - id: go
    needs: [route]
    when: { steps.route.outcome: quick }
    gate: { question: Go? }
  - id: check
    needs: [route]
    when: { steps.route.outcome: careful }
    gate: { question: Check? }
`,
      "b.yaml": `
title: B
inputs: { mode: { type: enum, values: [fast, slow], required: true } }
steps:
  - id: block
    playbook: { name: inner }
    inputs: { mode: "{{ playbook.inputs.mode }}" }
`,
    };
    const playbook = await playbookOf(files);
    const fast = start(playbook, { mode: "fast" });
    expect(readySteps(fast)).toEqual(["block.go"]);
    expect(status(fast, "block.check")).toBe("skipped");
    const slow = start(playbook, { mode: "slow" });
    expect(readySteps(slow)).toEqual(["block.check"]);
  });

  it("skips the cases of a branch that was itself skipped", async () => {
    const playbook = await playbookOf({
      "b.yaml": `
title: B
inputs: { env: { type: enum, values: [dev, prd], default: dev } }
steps:
  - id: route
    when: { env: prd }
    branch: { cases: [{ name: a }] }
  - id: member
    needs: [route]
    when: { steps.route.outcome: a }
    gate: { question: Go? }
  - id: after
    needs: [member]
    gate: { question: After? }
`,
    });
    const run = start(playbook);
    expect(status(run, "route")).toBe("skipped");
    expect(status(run, "member")).toBe("skipped");
    expect(readySteps(run)).toEqual(["after"]);
  });
});

describe("example playbook", () => {
  it("Route a change validates and takes the branch of what the classify step found", async () => {
    const entry = (await loadPlaybooks(EXAMPLES)).entries.find((candidate) => candidate.id === "route")!;
    expect(entry.errors).toEqual([]);
    const run = newRun({ id: "run_r", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: "/tmp/ws", projectId: "p", branch: "b", managerAgentId: "m", inputs: { request: "x" }, now: now() } as never);
    report(run, "classify", { kind: "infra", plan: "p" });
    expect(readySteps(run)).toEqual(["apply"]);
    expect(["ship", "review"].map((id) => status(run, id))).toEqual(["skipped", "skipped"]);
  });
});
