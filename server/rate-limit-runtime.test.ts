import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { RateHeldError, Runtime } from "./runtime";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
const saved = process.env.PASEO_HOME;
afterEach(async () => {
  if (saved === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = saved;
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
beforeEach(() => void (process.env.PASEO_HOME = ""));

const PLAYBOOK = `
title: Work
steps:
  - id: a
    role: { name: implementer, agent: { provider: claude, model: m } }
    manage: { auto_start: false }
`;

async function setup(rateLimits: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "rl-runtime-"));
  temps.push(dir);
  process.env.PASEO_HOME = dir;
  await mkdir(path.join(dir, "plugin-data/lerenn/paseo-playbooks"), { recursive: true });
  await writeFile(path.join(dir, "plugin-data/lerenn/paseo-playbooks/config.yaml"), rateLimits);
  const root = path.join(dir, "repo/.paseo/playbooks");
  await mkdir(path.join(root, "roles/implementer"), { recursive: true });
  await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
  await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(path.join(dir, "repo"))).entries.find((candidate) => candidate.id === "work")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const now = new Date().toISOString();
  for (const id of ["r0", "r1"]) await store.create(newRun({ id, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: id === "r0" ? now : new Date(Date.parse(now) + 1000).toISOString() }));
  const sent: string[] = [];
  const created: string[] = [];
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { id: "m", status: "running", provider: "claude", model: null, archivedAt: null } }), send: async (text: string) => void sent.push(text) }) },
    workspaces: { ref: () => ({ agents: { create: async () => ({ id: `step-${created.push("x")}`, send: async () => undefined }) } }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  return { store, runtime, sent, created };
}

describe("rate limiting in the runtime", () => {
  it("does nothing when no limit is set", async () => {
    const { runtime, store, created } = await setup("");
    await runtime.startStep("m", "r1", "a", "go");
    expect(created).toHaveLength(1);
    expect(store.get("r1")!.rateHold).toBeNull();
  });

  it("holds the second run at the playbook limit, tells its manager, and resumes it by itself when the first ends", async () => {
    const { runtime, store, sent } = await setup("rate_limits: { playbooks: 1 }");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toBeInstanceOf(RateHeldError);
    const hold = store.get("r1")!.rateHold!;
    expect(hold.kind).toBe("playbooks");
    expect(hold.reason).toContain("playbook limit");
    expect(store.get("r1")!.steps.a!.status).toBe("ready");
    expect(store.get("r1")!.inbox.join("\n") + sent.join("\n")).toContain("Rate limit: this run is on hold");
    // The first run ends: the plugin lifts the hold without any agent action.
    await store.mutate("r0", (run) => void (run.status = "completed"));
    await (runtime as unknown as { releaseHolds(): Promise<void> }).releaseHolds();
    expect(store.get("r1")!.rateHold).toBeNull();
    await runtime.startStep("m", "r1", "a", "go");
    expect(store.get("r1")!.steps.a!.status).toBe("running");
  });

  it("holds a step when the step limit is full", async () => {
    const { runtime, store } = await setup("rate_limits: { steps: 1 }");
    await runtime.startStep("m", "r0", "a", "go");
    await expect(runtime.startStep("m", "r1", "a", "go")).rejects.toThrow(/step limit reached/);
    expect(store.get("r1")!.rateHold!.kind).toBe("steps");
  });
});
