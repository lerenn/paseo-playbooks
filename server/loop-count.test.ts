import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Playbook } from "../shared/types";
import { completeStep, newRun, recordReport, refreshReady, startAttempt, endTurn } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function load(files: Record<string, string>, id: string): Promise<{ playbook: Playbook | null; errors: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === id)!;
  return { playbook: entry.playbook, errors: entry.errors };
}

const PB = `
steps:
  - id: draft
    role: { name: investigator, prompt: "Round {{ loop }}, attempt {{ attempt }}." }
  - id: polish
    needs: [draft]
    when: { loop: ">=1" }
    role: { name: implementer }
  - id: review
    needs: [draft, polish]
    role: { name: investigator }
    outcomes: [ok, redo]
    on:
      redo: { goto: draft }
`;

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();

function finish(run: ReturnType<typeof newRun>, stepId: string, outcome: string, agent: string) {
  startAttempt(run, stepId, { agentId: agent, brief: "", now: now(), readonlySnapshot: null });
  recordReport(run, agent, { outcome, summary: "done", outputs: {} }, now());
  endTurn(run, agent, { turnEnd: "completed", lastMessage: null, now: now() });
  return completeStep(run, stepId, { outcome, now: now() });
}

describe("loop count", () => {
  it("counts goto re-entries, renders {{ loop }} and gates `when: { loop }`", async () => {
    const { playbook, errors } = await load({ "p.yaml": PB }, "p");
    expect(errors).toEqual([]);
    expect(playbook!.steps[1]!.when).toEqual([{ input: "loop", source: "", values: [], loop: [{ op: ">=", value: 1 }] }]);
    const run = newRun({ id: "r", playbook: playbook!, workspaceId: "w", workspaceDir: "/tmp", projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: now() });

    const first = startAttempt(run, "draft", { agentId: "a1", brief: "", now: now(), readonlySnapshot: null });
    expect(first.prompt).toContain("Round 0, attempt 1.");
    recordReport(run, "a1", { outcome: "success", summary: "x", outputs: {} }, now());
    endTurn(run, "a1", { turnEnd: "completed", lastMessage: null, now: now() });
    completeStep(run, "draft", { outcome: "success", now: now() });
    // First pass: polish is skipped (loop 0), so review is ready.
    expect(run.steps.polish!.status).toBe("skipped");
    expect(run.steps.review!.status).toBe("ready");

    finish(run, "review", "redo", "a2");
    expect(run.steps.draft!.loop).toBe(1);
    expect(run.steps.review!.loop).toBe(1);
    const second = startAttempt(run, "draft", { agentId: "a3", brief: "", now: now(), readonlySnapshot: null });
    expect(second.prompt).toContain("Round 1, attempt 2.");
    recordReport(run, "a3", { outcome: "success", summary: "x", outputs: {} }, now());
    endTurn(run, "a3", { turnEnd: "completed", lastMessage: null, now: now() });
    completeStep(run, "draft", { outcome: "success", now: now() });
    // Second pass: loop is 1, so polish runs.
    expect(run.steps.polish!.status).toBe("ready");
    refreshReady(run, now());
  });

  it("refuses a malformed loop test and `loop` on a playbook step", async () => {
    const bad = await load({ "p.yaml": PB.replace('">=1"', '"often"') }, "p");
    expect(bad.errors.join("\n")).toMatch(/when\.loop: "often": expected a loop count/);
    const keyed = await load({ "p.yaml": `inputs: { loop: { required: true } }\n${PB.replace('{ loop: ">=1" }', "{ loop: x }")}`.replace("required: true", "values: [x, y], type: enum") }, "p");
    expect(keyed.errors).toEqual([]);
    expect(keyed.playbook!.steps[1]!.when![0]!.loop).toBeUndefined();
  });
});
