import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planAdmissions, slotHolders } from "../shared/slots";
import type { Playbook, Run } from "../shared/types";
import { admitBlock, completeStep, endTurn, newRun, queuedSteps, readySteps, recordReport, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function load(files: Record<string, string>, id: string): Promise<{ playbook: Playbook | null; errors: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "slots-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === id)!;
  return { playbook: entry.playbook, errors: entry.errors };
}

const PR = `
inputs: { request: { required: true } }
outputs: { pr_url: {} }
steps:
  - id: implement
    role: implementer
    inputs: [request]
    outputs: { pr_url: {} }
`;
const RELEASE = (concurrency: string) => `
title: Release
${concurrency}
inputs: { pr_url: { required: true } }
outputs: { env_url: {} }
steps:
  - id: prepare
    role: reviewer
    inputs: [pr_url]
    outputs: { ok: {} }
  - id: deploy
    role: reviewer
    needs: [prepare]
    inputs: [pr_url]
    outputs: { env_url: {} }
`;
const CAPABILITY = `
title: Capability
inputs: { request: { required: true } }
outputs: { env_url: {} }
steps:
  - id: pr
    playbook: pr
  - id: release
    needs: [pr]
    playbook: release
`;

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();

function start(playbook: Playbook, id: string, projectId = "p"): Run {
  return newRun({ id, playbook, workspaceId: `ws-${id}`, workspaceDir: "/tmp", projectId, branch: null, managerAgentId: `m-${id}`, inputs: { request: "x" }, now: now() });
}

function finish(run: Run, stepId: string, outputs: Record<string, string>) {
  const agentId = `a-${run.id}-${stepId}-${clock}`;
  startAttempt(run, stepId, { agentId, brief: "", now: now(), readonlySnapshot: null });
  recordReport(run, agentId, { outcome: "success", summary: "ok", outputs }, now());
  endTurn(run, agentId, { turnEnd: "completed", lastMessage: null, now: now() });
  return completeStep(run, stepId, { outcome: "success", now: now() });
}

/** Runs pr.implement to the point where the release block becomes (queued or) ready. */
function reachRelease(run: Run) {
  return finish(run, "pr.implement", { pr_url: "https://github.com/o/r/pull/1" });
}

/** Applies the plan the way the runtime does. */
function admit(runs: Run[]): string[] {
  const admitted: string[] = [];
  for (const { runId, prefix } of planAdmissions(runs)) admitted.push(...admitBlock(runs.find((run) => run.id === runId)!, prefix, now()));
  return admitted;
}

describe("concurrency on a sub-playbook", () => {
  it("carries the limit on the block, and still lets an unlimited sub-playbook through", async () => {
    const limited = await load({ "pr.yaml": PR, "release.yaml": RELEASE("concurrency: 1"), "capability.yaml": CAPABILITY }, "capability");
    expect(limited.errors).toEqual([]);
    expect(limited.playbook!.blocks).toEqual({
      pr: { title: "pr", playbook: "pr" },
      release: { title: "Release", playbook: "release", concurrency: 1 },
    });
    const free = await load({ "pr.yaml": PR, "release.yaml": RELEASE(""), "capability.yaml": CAPABILITY }, "capability");
    const run = start(free.playbook!, "r");
    expect(reachRelease(run).notes.join(" ")).not.toMatch(/Queued/);
    expect(readySteps(run)).toEqual(["release.prepare"]);
  });

  it("queues the second run's block while the first holds the slot, and admits it when the first is done", async () => {
    const { playbook } = await load({ "pr.yaml": PR, "release.yaml": RELEASE("concurrency: 1"), "capability.yaml": CAPABILITY }, "capability");
    const a = start(playbook!, "a");
    const b = start(playbook!, "b");
    // PR work is not limited: both run in parallel.
    expect(readySteps(a)).toEqual(["pr.implement"]);
    expect(readySteps(b)).toEqual(["pr.implement"]);

    expect(reachRelease(a).notes.join(" ")).toMatch(/Queued: release\.prepare/);
    expect(queuedSteps(a)).toEqual(["release.prepare"]);
    expect(admit([a, b])).toEqual(["release.prepare"]);
    expect(readySteps(a)).toEqual(["release.prepare"]);

    const notes = reachRelease(b).notes.join(" ");
    expect(notes).toMatch(/Queued: release\.prepare, waiting for a free "release" slot/);
    expect(b.steps["release.prepare"]!.status).toBe("queued");
    expect(admit([a, b])).toEqual([]);

    // The slot stays held through the block, even between its steps.
    finish(a, "release.prepare", { ok: "y" });
    expect(readySteps(a)).toEqual(["release.deploy"]);
    expect(admit([a, b])).toEqual([]);
    expect(slotHolders([a, b], "p", "release")).toEqual(["a:release"]);

    finish(a, "release.deploy", { env_url: "https://dev" });
    expect(a.status).toBe("completed");
    expect(admit([a, b])).toEqual(["release.prepare"]);
    expect(b.steps["release.prepare"]!.status).toBe("ready");
    expect(b.steps["release.prepare"]!.queuedAt).toBeNull();
  });

  it("admits waiting runs oldest first, honours N slots, and frees the slot of a canceled run", async () => {
    const { playbook } = await load({ "pr.yaml": PR, "release.yaml": RELEASE("concurrency: 2"), "capability.yaml": CAPABILITY }, "capability");
    const runs = ["a", "b", "c", "d"].map((id) => start(playbook!, id));
    for (const run of runs) reachRelease(run);
    expect(admit(runs)).toEqual(["release.prepare", "release.prepare"]);
    expect(runs.map((run) => run.steps["release.prepare"]!.status)).toEqual(["ready", "ready", "queued", "queued"]);
    expect(planAdmissions(runs)).toEqual([]);

    runs[0]!.status = "canceled";
    expect(planAdmissions(runs)).toEqual([{ runId: "c", prefix: "release" }]);
    admit(runs);
    expect(runs[2]!.steps["release.prepare"]!.status).toBe("ready");
    expect(runs[3]!.steps["release.prepare"]!.status).toBe("queued");
  });

  it("scopes slots to the project and counts a top-level run of the same playbook", async () => {
    const { playbook } = await load({ "pr.yaml": PR, "release.yaml": RELEASE("concurrency: 1"), "capability.yaml": CAPABILITY }, "capability");
    const a = start(playbook!, "a", "p1");
    const b = start(playbook!, "b", "p2");
    reachRelease(a);
    reachRelease(b);
    expect(admit([a, b])).toEqual(["release.prepare", "release.prepare"]);

    const release = (await load({ "release.yaml": RELEASE("concurrency: 1") }, "release")).playbook!;
    const top = newRun({ id: "t", playbook: release, workspaceId: "w", workspaceDir: "/tmp", projectId: "p3", branch: null, managerAgentId: "m", inputs: { pr_url: "u" }, now: now() });
    const c = start(playbook!, "c", "p3");
    reachRelease(c);
    expect(slotHolders([top, c], "p3", "release")).toEqual(["t"]);
    expect(admit([top, c])).toEqual([]);
    top.status = "completed";
    expect(admit([top, c])).toEqual(["release.prepare"]);
  });
});
