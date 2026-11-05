import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Just enough of the daemon API to start step agents and archive them. */
function fakePaseo() {
  const archivedAt: Record<string, string | null> = { m: null };
  const archived: string[] = [];
  let next = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: archivedAt[agentId] ?? null } }),
    send: async () => undefined,
    archive: async () => {
      archived.push(agentId);
      archivedAt[agentId] = new Date().toISOString();
      return { archivedAt: archivedAt[agentId] };
    },
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  const create = async () => {
    const id = `agent-${++next}`;
    archivedAt[id] = null;
    return { id, ...ref(id) };
  };
  return { paseo: { agents: { ref }, workspaces: { ref: () => ({ agents: { create } }) } }, archived };
}

async function setup(stepExtra = "") {
  const dir = await mkdtemp(path.join(tmpdir(), "archive-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(
    path.join(root, "release.yaml"),
    `title: Release\nsteps:\n  - id: a\n    role: implementer\n    retries: 1\n${stepExtra}  - id: b\n    role: implementer\n    needs: [a]\n`,
  );
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "release")!.playbook!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  await store.create(newRun({ id: "run_x", playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() }));
  const fake = fakePaseo();
  const runtime = new Runtime(store);
  await runtime.attach(fake.paseo as never);
  return { store, runtime, ...fake };
}

/** Runs one attempt of step "a" to the given outcome. */
async function attempt(runtime: Runtime, outcome: "success" | "failure"): Promise<string> {
  const { agentId } = await runtime.startStep("m", "run_x", "a", "");
  await runtime.report(agentId, { outcome, summary: outcome, outputs: {} });
  await runtime.onTurnEnded(agentId, "completed");
  await runtime.completeStep("m", "run_x", "a", { outcome });
  return agentId;
}

describe("step agents the run no longer needs", () => {
  it("are archived when the next attempt starts and when the step completes", async () => {
    const { store, runtime, archived } = await setup();
    const first = await attempt(runtime, "failure");
    expect(archived).toEqual([]);
    const second = await attempt(runtime, "success");
    expect(archived).toEqual([first, second]);

    // Paseo's archive hook for a completed step's agent changes nothing.
    await runtime.onAgentArchived(second, "m");
    const run = store.get("run_x")!;
    expect(run.status).toBe("running");
    expect(run.steps.a!.status).toBe("completed");
    expect(run.steps.b!.status).toBe("ready");
  });

  it("are archived when the step fails the run", async () => {
    const { store, runtime, archived } = await setup();
    const first = await attempt(runtime, "failure");
    const second = await attempt(runtime, "failure");
    expect(store.get("run_x")!.status).toBe("failed");
    expect(archived).toEqual([first, second]);

    // Paseo's archive hook for an ended step's agent changes nothing.
    await runtime.onAgentArchived(second, "m");
    expect(store.get("run_x")!.status).toBe("failed");
  });

  it("are archived, not only stopped, when the run is canceled", async () => {
    const { store, runtime, archived } = await setup();
    const { agentId } = await runtime.startStep("m", "run_x", "a", "");
    await runtime.cancelRun("run_x", "no longer needed", null);
    expect(archived).toEqual([agentId]);

    await runtime.onAgentArchived(agentId, "m");
    const run = store.get("run_x")!;
    expect(run.status).toBe("canceled");
    expect(run.steps.a!.status).toBe("failed");
  });

  it("are kept with archive_agents: false", async () => {
    const { runtime, archived } = await setup("    archive_agents: false\n");
    await attempt(runtime, "failure");
    await attempt(runtime, "success");
    expect(archived).toEqual([]);
  });

  it("are kept with archive_agents: false when the run fails", async () => {
    const { store, runtime, archived } = await setup("    archive_agents: false\n");
    await attempt(runtime, "failure");
    await attempt(runtime, "failure");
    expect(store.get("run_x")!.status).toBe("failed");
    expect(archived).toEqual([]);
  });
});
