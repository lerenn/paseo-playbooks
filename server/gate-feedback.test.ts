import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { completeStep, decideGate, endTurn, newRun, recordReport, requestGate, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function load(yaml: string): Promise<Playbook> {
  const dir = await mkdtemp(path.join(tmpdir(), "gatefb-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "p.yaml"), yaml);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "p")!;
  expect(entry.errors).toEqual([]);
  return entry.playbook!;
}

const LIMIT = `
steps:
  - id: draft
    role: { name: investigator }
  - id: review
    needs: [draft]
    role: { name: investigator }
    outcomes: [ok, redo]
    on:
      redo: { goto: draft, max_loops: 1 }
`;

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();
let agents = 0;

function report(run: Run, stepId: string, outcome: string, summary: string) {
  const agentId = `a${++agents}`;
  startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
  recordReport(run, agentId, { outcome, summary, outputs: {} }, now());
  endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  return completeStep(run, stepId, { outcome, now: now() });
}

/** Runs draft/review until the loop-limit gate of review → draft is open. */
async function atLimit(yaml = LIMIT): Promise<Run> {
  const run = newRun({ id: "r", playbook: await load(yaml), workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });
  report(run, "draft", "success", "d1");
  report(run, "review", "redo", "needs work");
  report(run, "draft", "success", "d2");
  report(run, "review", "redo", "still needs work");
  expect(run.gates.at(-1)!.kind).toBe("loop_limit");
  return run;
}

describe("a gate decision's comment reaches the goto target as feedback", () => {
  it("a human's comment on the loop-limit gate", async () => {
    const run = await atLimit();
    decideGate(run, "review", { decision: "approved", comment: "focus on the tests", by: "louis", via: "panel", now: now() });
    expect(run.steps.draft!.feedback).toBe("still needs work\n\nOn the loop limit, the human said: focus on the tests");
  });

  it("keeps the step's feedback alone when there is no comment", async () => {
    const run = await atLimit();
    decideGate(run, "review", { decision: "approved", comment: null, by: null, via: "panel", now: now() });
    expect(run.steps.draft!.feedback).toBe("still needs work");
  });

  it("the manager's and a role's reasons say who decided", async () => {
    const byManager = await atLimit();
    byManager.gates.at(-1)!.decider = { by: "manager" };
    decideGate(byManager, "review", { decision: "approved", comment: "only nits left", by: "manager", via: "manager", now: now() });
    expect(byManager.steps.draft!.feedback).toContain("the manager said: only nits left");

    const byRole = await atLimit();
    byRole.gates.at(-1)!.decider = { by: "role", role: "gatekeeper" };
    decideGate(byRole, "review", { decision: "approved", comment: "one more pass", by: "gatekeeper", via: "role", now: now() });
    expect(byRole.steps.draft!.feedback).toContain('the role "gatekeeper" said: one more pass');
  });

  it("a gate step's goto and an ask, by a human or the manager", async () => {
    const run = newRun({
      id: "r",
      playbook: await load(`
steps:
  - id: draft
    role: { name: investigator }
  - id: ok
    needs: [draft]
    gate: { question: "Fine?", choices: { approve: { label: Approve }, rework: { label: Rework, comment: required } } }
    on:
      rework: { goto: draft }
`),
      workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now(),
    });
    report(run, "draft", "success", "d1");
    requestGate(run, "ok", "ready?", now());
    decideGate(run, "ok", { decision: "rework", comment: "more detail", by: "louis", via: "chat", now: now() });
    expect(run.steps.draft!.feedback).toBe("more detail");

    report(run, "draft", "success", "d2");
    requestGate(run, "ok", "ready?", now());
    run.gates.at(-1)!.decider = { by: "manager" };
    decideGate(run, "ok", { decision: "rework", comment: "add examples", by: "manager", via: "manager", now: now() });
    expect(run.steps.draft!.feedback).toBe("the manager decided: add examples");
  });
});
