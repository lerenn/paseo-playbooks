import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { completeStep, decideGate, endTurn, newRun, readySteps, recordReport, requestGate, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function load(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "outcomes-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return new Map((await loadPlaybooks(dir)).entries.map((entry) => [entry.id, entry]));
}

// One environment's release, used three times: `no_deploy` ends it with an outcome of its own.
const ENV = `
hidden: true
outcomes: [success, no_deploy]
inputs:
  env: { required: true }
  release_timeout: {}
outputs:
  env_url: {}
steps:
  - id: release
    role: implementer
    inputs: [env, release_timeout]
    outputs: { env_url: {} }
    outcomes: [success, no_deploy, failure]
    on:
      no_deploy: { end: no_deploy }
    timeout: "{{ inputs.release_timeout }}"
    prompt: "Release {{ inputs.env }}"
  - id: qa
    role: reviewer
    needs: [release]
    inputs: [env_url]
`;
const RELEASE = `
outcomes: [success, no_deploy]
steps:
  - id: dev
    playbook: env
    inputs: { env: dev, release_timeout: 5h }
    on:
      no_deploy: { end: no_deploy }
  - id: stg
    playbook: env
    needs: [dev]
    inputs: { env: stg, release_timeout: 4h }
    on: { no_deploy: end }
  - id: prd_go
    needs: [stg]
    gate: Go to prd?
  - id: prd
    playbook: env
    needs: [prd_go]
    inputs: { env: prd, release_timeout: 6h }
    on: { no_deploy: end }
`;
const ticket = (route: string) => `
steps:
  - id: release
    playbook: release
    on: { no_deploy: ${route} }
  - id: announce
    role: reviewer
    needs: [release]
`;

function drive(playbook: Playbook, inputs: Record<string, string> = {}) {
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 10, 5, 12, 0, clock++)).toISOString();
  const run: Run = newRun({ id: "run_o", playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs, now: now() });
  const finish = (stepId: string, outcome: string, outputs: Record<string, string> = {}) => {
    const agentId = `a-${stepId}-${clock}`;
    startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
    recordReport(run, agentId, { outcome, summary: "ok", outputs }, now());
    endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
    return completeStep(run, stepId, { outcome, now: now() });
  };
  return { run, finish, now };
}

describe("sub-playbook outcomes", () => {
  it("carries the sub-playbook's outcomes and the parent step's `on` on the block", async () => {
    const entries = await load({ "env.yaml": ENV, "release.yaml": RELEASE, "ticket.yaml": ticket("complete") });
    expect(entries.get("ticket")!.errors).toEqual([]);
    const playbook = entries.get("ticket")!.playbook!;
    expect(entries.get("release")!.playbook!.outcomes).toEqual(["success", "no_deploy"]);
    expect(playbook.outcomes).toEqual(["success"]);
    expect(playbook.blocks.release).toMatchObject({ outcomes: ["success", "no_deploy"], on: { no_deploy: { kind: "complete" } } });
    expect(playbook.blocks["release.dev"]).toMatchObject({ outcomes: ["success", "no_deploy"], on: { no_deploy: { kind: "end", outcome: "no_deploy" } } });
    expect(playbook.blocks["release.stg"]).toMatchObject({ on: { no_deploy: { kind: "end" } } });
    expect(playbook.steps.find((step) => step.id === "release.dev.release")!.on.no_deploy).toEqual({ kind: "end", outcome: "no_deploy" });
  });

  it("an outcome that ends the parent block skips its later steps, then the run goes on", async () => {
    const entries = await load({ "env.yaml": ENV, "release.yaml": RELEASE, "ticket.yaml": ticket("complete") });
    const { run, finish } = drive(entries.get("ticket")!.playbook!);
    const fx = finish("release.dev.release", "no_deploy", { env_url: "none" });
    for (const id of ["release.dev.qa", "release.stg.release", "release.stg.qa", "release.prd_go", "release.prd.release", "release.prd.qa"]) {
      expect(run.steps[id]!.status).toBe("skipped");
    }
    expect(fx.notes.join("\n")).toMatch(/ended block "release.dev" with "no_deploy"/);
    expect(fx.notes.join("\n")).toMatch(/block "release.dev" \(no_deploy\) ended block "release" with "no_deploy"/);
    expect(readySteps(run)).toEqual(["announce"]);
    finish("announce", "success");
    expect(run.status).toBe("completed");
  });

  it("an `end` route ends the run, and a `fail` route fails it", async () => {
    const ended = drive((await load({ "env.yaml": ENV, "release.yaml": RELEASE, "ticket.yaml": ticket("end") })).get("ticket")!.playbook!);
    ended.finish("release.dev.release", "no_deploy", { env_url: "none" });
    expect(ended.run.status).toBe("completed");
    expect(ended.run.steps.announce!.status).toBe("pending");

    const failed = drive((await load({ "env.yaml": ENV, "release.yaml": RELEASE, "ticket.yaml": ticket("fail") })).get("ticket")!.playbook!);
    failed.finish("release.dev.release", "no_deploy", { env_url: "none" });
    expect(failed.run.status).toBe("failed");
    expect(failed.run.failure).toBe('block "release" ended with "no_deploy"');
  });

  it("run alone, the playbook completes with the outcome; the first outcome keeps the old behaviour", async () => {
    const entries = await load({ "env.yaml": ENV, "release.yaml": RELEASE });
    const alone = drive(entries.get("release")!.playbook!);
    alone.finish("dev.release", "no_deploy", { env_url: "none" });
    expect(alone.run.status).toBe("completed");
    expect(alone.run.history.some((event) => event.type === "run_outcome" && event.detail === "no_deploy")).toBe(true);

    const normal = drive(entries.get("release")!.playbook!);
    normal.finish("dev.release", "success", { env_url: "https://dev" });
    normal.finish("dev.qa", "success");
    expect(readySteps(normal.run)).toEqual(["stg.release"]);
    normal.finish("stg.release", "success", { env_url: "https://stg" });
    normal.finish("stg.qa", "success");
    requestGate(normal.run, "prd_go", "Go?", normal.now());
    decideGate(normal.run, "prd_go", { decision: "approved", comment: null, by: null, via: "panel", now: normal.now() });
    expect(readySteps(normal.run)).toEqual(["prd.release"]);
  });

  it("validates outcomes and their routes", async () => {
    const entries = await load({
      "env.yaml": ENV,
      "unrouted.yaml": "steps:\n  - id: dev\n    playbook: env\n    inputs: { env: dev }\n",
      "goto.yaml": "steps:\n  - id: a\n    role: reviewer\n  - id: dev\n    playbook: env\n    needs: [a]\n    inputs: { env: dev }\n    on: { no_deploy: { goto: a } }\n",
      "unknown.yaml": "steps:\n  - id: dev\n    playbook: env\n    inputs: { env: dev }\n    on: { no_deploy: complete, other: end }\n",
      "undeclared.yaml": "steps:\n  - id: a\n    role: reviewer\n    outcomes: [success, skip]\n    on: { skip: { end: skip } }\n",
      "after.yaml": "steps:\n  - id: a\n    role: reviewer\nafter:\n  - id: dev\n    playbook: env\n    inputs: { env: dev }\n    on: { no_deploy: end }\n",
    });
    expect(entries.get("env")!.errors).toEqual([]);
    expect(entries.get("unrouted")!.errors.join("\n")).toMatch(/outcome "no_deploy" of playbook "env" needs an `on` entry/);
    expect(entries.get("goto")!.errors.join("\n")).toMatch(/leads to complete, end or fail/);
    expect(entries.get("unknown")!.errors.join("\n")).toMatch(/on.other: not an outcome of playbook "env"/);
    expect(entries.get("undeclared")!.errors.join("\n")).toMatch(/end: "skip" is not an outcome of this playbook/);
    expect(entries.get("after")!.errors.join("\n")).toMatch(/`on` does not apply to an after-task/);
  });
});

describe("templated timeout", () => {
  it("resolves per attempt from the step's inputs, and falls back to the default when empty", async () => {
    const entries = await load({ "env.yaml": ENV, "release.yaml": RELEASE });
    const playbook = entries.get("release")!.playbook!;
    expect(playbook.steps.find((step) => step.id === "dev.release")!.timeout).toBe("{{ inputs.release_timeout }}");
    const { run, finish, now } = drive(playbook);
    const started = startAttempt(run, "dev.release", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    expect(started.attempt.timeoutMs).toBe(5 * 3_600_000);
    recordReport(run, "a1", { outcome: "success", summary: "ok", outputs: { env_url: "u" } }, now());
    completeStep(run, "dev.release", { outcome: "success", now: now() });
    finish("dev.qa", "success");
    expect(startAttempt(run, "stg.release", { agentId: "a2", brief: "", now: now(), readonlySnapshot: null }).attempt.timeoutMs).toBe(4 * 3_600_000);

    const alone = drive(entries.get("env")!.playbook!, { env: "dev" });
    expect(startAttempt(alone.run, "release", { agentId: "a3", brief: "", now: alone.now(), readonlySnapshot: null }).attempt.timeoutMs).toBeNull();
  });

  it("refuses a bad duration when the run starts, or when the step starts if it comes from a step output", async () => {
    const entries = await load({
      "env.yaml": ENV,
      "bad.yaml": "steps:\n  - id: dev\n    playbook: env\n    inputs: { env: dev, release_timeout: soon }\n    on: { no_deploy: end }\n",
      "late.yaml": `
steps:
  - id: plan
    role: reviewer
    outputs: { hours: {} }
  - id: work
    role: implementer
    needs: [plan]
    inputs: { budget: "{{ steps.plan.outputs.hours }}h" }
    timeout: "{{ inputs.budget }}"
`,
      "refs.yaml": "steps:\n  - id: a\n    role: reviewer\n    timeout: \"{{ inputs.nope }}\"\n  - id: b\n    role: reviewer\n    needs: [a]\n    timeout: \"{{ run.id }}\"\n",
    });
    expect(entries.get("bad")!.errors).toEqual([]);
    expect(() => drive(entries.get("bad")!.playbook!)).toThrow(/timeout "\{\{ inputs.release_timeout \}\}" gave "soon"/);

    const late = drive(entries.get("late")!.playbook!);
    late.finish("plan", "success", { hours: "two" });
    expect(() => startAttempt(late.run, "work", { agentId: "w", brief: "", now: late.now(), readonlySnapshot: null })).toThrow(/gave "twoh"/);

    const errors = entries.get("refs")!.errors.join("\n");
    expect(errors).toMatch(/step "a": timeout uses "\{\{ inputs.nope \}\}" but the step declares no such input/);
    expect(errors).toMatch(/step "b": timeout uses "\{\{ run.id \}\}"; a timeout may only use inputs.<name>/);
  });
});
