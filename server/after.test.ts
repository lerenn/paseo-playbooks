import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { isActive, RunSchema } from "../shared/types";
import { cancelRun, completeStep, decideGate, endTurn, failRun, newRun, readySteps, recordReport, requestGate, startAfterTask, startAttempt, stepInputs } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "after-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return dir;
}

/** A retro playbook: reads the run it reflects on. Its own after-task must be ignored when nested. */
const RETRO = `
title: Retro
concurrency: 1
inputs:
  run_id: { required: true }
  run_status: {}
steps:
  - id: reflect
    role: reviewer
    inputs: [run_id, run_status]
    outputs: { notes: {} }
    prompt: "Reflect on run {{ inputs.run_id }} ({{ inputs.run_status }})."
  - id: propose
    role: reviewer
    needs: [reflect]
    inputs: [notes]
after:
  - id: nested_after
    role: reviewer
`;

const MAIN = `
title: Main
inputs:
  request: { required: true }
outputs:
  plan: {}
steps:
  - id: investigate
    role: investigator
    inputs: [request]
    outputs: { plan: {} }
  - id: implement
    role: implementer
    needs: [investigate]
    inputs: [plan]
    outcomes: [success, give_up]
    on:
      give_up: fail
after:
  - id: retro
    playbook: retro
  - id: notify
    role: reviewer
    trigger: manual
    inputs:
      plan: ~
      status: "{{ run.status }}"
      why: "{{ run.failure }}"
      investigated: "{{ steps.investigate.outputs.plan }}"
    outcomes: [success, failure, stop]
    on:
      stop: end
    prompt: "The run is {{ run.status }}. {{ inputs.status }}"
`;

async function load(files: Record<string, string>): Promise<Map<string, ReturnType<typeof Object>>> {
  const dir = await folder(files);
  return new Map((await loadPlaybooks(dir)).entries.map((entry) => [entry.id, entry]));
}

async function mainPlaybook(): Promise<Playbook> {
  const entries = await load({ "main.yaml": MAIN, "retro.yaml": RETRO });
  const entry = entries.get("main") as { errors: string[]; playbook: Playbook };
  expect(entry.errors).toEqual([]);
  return entry.playbook;
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 3, 12, 0, clock++)).toISOString();

function start(playbook: Playbook): Run {
  return newRun({ id: "run_a", playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "Add X" }, now: now() });
}

function step(run: Run, stepId: string, outcome: string, outputs: Record<string, string> = {}) {
  const agentId = `a-${stepId}-${clock}`;
  const started = startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
  recordReport(run, agentId, { outcome, summary: `${stepId} ${outcome}`, outputs }, now());
  endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  return { started, fx: completeStep(run, stepId, { outcome, now: now() }) };
}

describe("after-tasks: loader", () => {
  it("parses agent and sub-playbook after-tasks, outside the main graph", async () => {
    const playbook = await mainPlaybook();
    expect(playbook.after).toEqual([
      { id: "retro", title: "Retro", trigger: "auto", steps: ["retro.reflect", "retro.propose"] },
      { id: "notify", title: "Notify", trigger: "manual", steps: ["notify"] },
    ]);
    const byId = new Map(playbook.steps.map((s) => [s.id, s]));
    expect(byId.get("investigate")!.afterTask).toBeUndefined();
    expect(byId.get("retro.reflect")).toMatchObject({ afterTask: "retro", needs: [] });
    expect(byId.get("retro.propose")).toMatchObject({ afterTask: "retro", needs: ["retro.reflect"] });
    // The retro's inputs match the run's fields by name.
    expect(byId.get("retro.reflect")!.inputs.run_id!.source).toBe("{{ run.id }}");
    expect(byId.get("retro.reflect")!.inputs.run_status!.source).toBe("{{ run.status }}");
    // Playbook outputs auto-match before playbook inputs; main step outputs can be mapped.
    expect(byId.get("notify")!.inputs.plan!.source).toBe("{{ run.outputs.plan }}");
    expect(byId.get("notify")!.inputs.investigated!.source).toBe("{{ steps.investigate.outputs.plan }}");
    // A nested playbook's own after-tasks are ignored, and its concurrency too.
    expect(byId.has("retro.nested_after")).toBe(false);
    expect(playbook.blocks.retro).toEqual({ title: "Retro", playbook: "retro" });
    // The playbook's outputs come from main steps only.
    expect(playbook.outputs.plan!.source).toBe("{{ steps.investigate.outputs.plan }}");
  });

  it("refuses needs on an after-task, trigger on a step, run.status in a main step, and clashing ids", async () => {
    const entries = await load({
      "a.yaml": "steps:\n  - id: x\n    role: reviewer\nafter:\n  - id: y\n    role: reviewer\n    needs: [x]\n",
      "b.yaml": "steps:\n  - id: x\n    role: reviewer\n    trigger: manual\n",
      "c.yaml": 'steps:\n  - id: x\n    role: reviewer\n    prompt: "{{ run.status }}"\n',
      "d.yaml": "steps:\n  - id: x\n    role: reviewer\nafter:\n  - id: x\n    role: reviewer\n",
      "e.yaml": "steps:\n  - id: x\n    role: reviewer\n    needs: [y]\nafter:\n  - id: y\n    role: reviewer\n",
      "f.yaml": 'steps:\n  - id: x\n    role: reviewer\n    inputs: { id: "{{ run.id }}" }\n',
    });
    const errors = (id: string) => (entries.get(id) as { errors: string[] }).errors.join("\n");
    expect(errors("a")).toMatch(/after "y": `needs` does not apply/);
    expect(errors("b")).toMatch(/`trigger` only applies to an after-task/);
    expect(errors("c")).toMatch(/only after-tasks can use/);
    expect(errors("d")).toMatch(/duplicate id/);
    expect(errors("e")).toMatch(/needs unknown step "y" \(an after-task\)/);
    expect(errors("f")).toMatch(/must be playbook.inputs/);
  });

  it("applies the parallel-edit rule between after-tasks, not between an after-task and a main step", async () => {
    const entries = await load({
      "ok.yaml": "steps:\n  - id: x\n    role: implementer\nafter:\n  - id: y\n    role: implementer\n",
      "bad.yaml": "steps:\n  - id: x\n    role: reviewer\nafter:\n  - id: y\n    role: implementer\n  - id: z\n    role: implementer\n",
    });
    expect((entries.get("ok") as { errors: string[] }).errors).toEqual([]);
    expect((entries.get("bad") as { errors: string[] }).errors.join("\n")).toMatch(/"y" and "z" can run at the same time/);
  });
});

describe("after-tasks: engine", () => {
  it("starts auto tasks when the run completes; they read the run; their end does not touch the run", async () => {
    const run = start(await mainPlaybook());
    expect(run.after).toMatchObject({ retro: { status: "pending" }, notify: { status: "pending" } });
    step(run, "investigate", "success", { plan: "the plan" });
    const { fx } = step(run, "implement", "success");
    expect(run.status).toBe("completed");
    expect(run.outputs).toEqual({ plan: "the plan" });
    expect(run.after.retro!.status).toBe("running");
    expect(run.after.notify!.status).toBe("pending");
    expect(isActive(run)).toBe(true);
    expect(readySteps(run)).toEqual(["retro.reflect"]);
    expect(fx.notes.join(" ")).toMatch(/After-task started: retro\. It does not change the run's result \(completed\)/);
    const { started } = step(run, "retro.reflect", "success", { notes: "n" });
    expect(started.prompt).toContain("Reflect on run run_a (completed).");
    expect(readySteps(run)).toEqual(["retro.propose"]);
    step(run, "retro.propose", "success");
    expect(run.after.retro!.status).toBe("completed");
    expect(run.status).toBe("completed");
    expect(isActive(run)).toBe(false);
  });

  it("starts auto tasks when the run fails, with its failure and partial outputs; a task failure stays on the task", async () => {
    const playbook = await mainPlaybook();
    const run = start(playbook);
    step(run, "investigate", "success", { plan: "p1" });
    step(run, "implement", "give_up");
    expect(run.status).toBe("failed");
    expect(run.after.retro!.status).toBe("running");
    // Manual tasks wait for a human, even on a failed run.
    expect(run.after.notify!.status).toBe("pending");
    startAfterTask(run, "notify", now());
    const notify = playbook.steps.find((s) => s.id === "notify")!;
    const inputs = stepInputs(run, notify);
    expect(inputs.plan!.value).toBe("p1");
    expect(inputs.status!.value).toBe("failed");
    expect(inputs.why!.value).toMatch(/implement/);
    step(run, "notify", "failure");
    expect(run.after.notify).toMatchObject({ status: "failed", detail: expect.stringMatching(/failed after 1 attempt/) });
    expect(run.status).toBe("failed");
    expect(run.failure).toMatch(/implement/);
    // The other task keeps running.
    expect(run.after.retro!.status).toBe("running");
    expect(readySteps(run)).toEqual(["retro.reflect"]);
  });

  it("does not start auto tasks on a canceled run; manual ones can still start", async () => {
    const run = start(await mainPlaybook());
    cancelRun(run, "no longer needed", now());
    expect(run.status).toBe("canceled");
    expect(run.after.retro).toMatchObject({ status: "canceled", detail: "the run was canceled" });
    expect(readySteps(run)).toEqual([]);
    startAfterTask(run, "notify", now());
    expect(readySteps(run)).toEqual(["notify"]);
    expect(() => startAfterTask(run, "notify", now())).toThrow(/runs once/);
    expect(() => startAfterTask(run, "retro", now())).toThrow(/trigger: auto/);
  });

  it("refuses to start a manual task before the run ends", async () => {
    const run = start(await mainPlaybook());
    expect(() => startAfterTask(run, "notify", now())).toThrow(/once it has ended/);
  });

  it("end inside an after-task completes only the task", async () => {
    const run = start(await mainPlaybook());
    step(run, "investigate", "success", { plan: "p" });
    step(run, "implement", "success");
    startAfterTask(run, "notify", now());
    step(run, "notify", "stop");
    expect(run.after.notify!.status).toBe("completed");
    expect(run.status).toBe("completed");
    expect(run.after.retro!.status).toBe("running");
  });

  it("cancel during wrap-up cancels the after-tasks, not the run; manager loss too", async () => {
    const run = start(await mainPlaybook());
    step(run, "investigate", "success", { plan: "p" });
    step(run, "implement", "success");
    const agentId = "retro-agent";
    startAttempt(run, "retro.reflect", { agentId, brief: "", now: now(), readonlySnapshot: null });
    const fx = cancelRun(run, "stop it", now());
    expect(fx.cancelAgents).toEqual([agentId]);
    expect(run.status).toBe("completed");
    expect(run.after.retro).toMatchObject({ status: "canceled", detail: "stop it" });
    expect(isActive(run)).toBe(false);
    expect(() => cancelRun(run, "again", now())).toThrow(/is completed/);

    const other = start(await mainPlaybook());
    step(other, "investigate", "success", { plan: "p" });
    step(other, "implement", "give_up");
    failRun(other, "manager lost", now());
    expect(other.status).toBe("failed");
    expect(other.failure).toMatch(/implement/);
    expect(other.after.retro!.status).toBe("canceled");
  });

  it("a manager lost during the main graph fails the run without starting after-tasks", async () => {
    const run = start(await mainPlaybook());
    failRun(run, "manager lost", now());
    expect(run.status).toBe("failed");
    expect(run.after.retro).toMatchObject({ status: "canceled", detail: "manager lost" });
  });

  it("a rejected gate inside an after-task fails the task only", async () => {
    const entries = await load({
      "g.yaml": "steps:\n  - id: x\n    role: reviewer\nafter:\n  - id: check\n    gate: Was it good?\n",
    });
    const playbook = (entries.get("g") as { playbook: Playbook }).playbook;
    const run = newRun({ id: "run_g", playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
    step(run, "x", "success");
    expect(readySteps(run)).toEqual(["check"]);
    requestGate(run, "check", "Was it good?", now());
    expect(run.status).toBe("completed");
    decideGate(run, "check", { decision: "rejected", comment: "meh", by: null, via: "panel", now: now() });
    expect(run.status).toBe("completed");
    expect(run.after.check!.status).toBe("failed");
  });

  it("end in an after-task's sub-playbook: at its top level ends the task; in a nested block ends only that block", async () => {
    const inner = "inputs:\n  run_id: {}\nsteps:\n  - id: look\n    role: reviewer\n    outcomes: [success, enough]\n    on:\n      enough: end\n  - id: more\n    role: reviewer\n    needs: [look]\n";
    const outer = "steps:\n  - id: deep\n    playbook: inner\n  - id: wrap\n    role: reviewer\n    needs: [deep]\n    outcomes: [success, done]\n    on:\n      done: end\n  - id: tail\n    role: reviewer\n    needs: [wrap]\n";
    const entries = await load({
      "inner.yaml": inner,
      "outer.yaml": outer,
      "m.yaml": "steps:\n  - id: x\n    role: reviewer\nafter:\n  - id: retro\n    playbook: outer\n",
    });
    const entry = entries.get("m") as { errors: string[]; playbook: Playbook };
    expect(entry.errors).toEqual([]);
    const run = newRun({ id: "run_e", playbook: entry.playbook, workspaceId: "ws", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
    step(run, "x", "success");
    expect(readySteps(run)).toEqual(["retro.deep.look"]);
    // Nested block: only retro.deep ends; the task goes on.
    step(run, "retro.deep.look", "enough");
    expect(run.steps["retro.deep.more"]!.status).toBe("skipped");
    expect(run.after.retro!.status).toBe("running");
    expect(readySteps(run)).toEqual(["retro.wrap"]);
    // The task's top level: end completes the task, the run is untouched.
    step(run, "retro.wrap", "done");
    expect(run.after.retro!.status).toBe("completed");
    expect(run.status).toBe("completed");
  });

  it("reads a run file saved before after-tasks existed", async () => {
    const run = start(await mainPlaybook());
    const old = JSON.parse(JSON.stringify(run)) as Record<string, unknown> & { playbook: Record<string, unknown> & { steps: Array<Record<string, unknown>> } };
    delete old.after;
    delete old.playbook.after;
    old.playbook.steps = old.playbook.steps.filter((s) => !s.afterTask);
    const parsed = RunSchema.parse(old);
    expect(parsed.after).toEqual({});
    expect(parsed.playbook.after).toEqual([]);
    expect(isActive(parsed)).toBe(true);
  });
});
