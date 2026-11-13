import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managerKickoff } from "./prompts";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakePaseo(dir: string) {
  const created: Array<{ title: string; config: { provider?: string } }> = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => undefined,
  });
  const workspace = {
    id: "ws",
    projectId: "p",
    workspaceDirectory: dir,
    agents: {
      create: async (input: (typeof created)[number]) => {
        created.push(input);
        const id = `step-${created.length}`;
        return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
      },
    },
  };
  const providers = { listModels: async (provider: string) => ({ provider, models: [{ id: "claude-haiku-5-5" }, { id: "claude-opus-5-5" }] }) };
  return { paseo: { agents: { ref }, workspaces: { ref: () => ({ ...workspace, refresh: async () => workspace }) }, providers }, created, sent };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "autostart-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(
    path.join(root, "two.yaml"),
    `title: Two
steps:
  - id: a
    role: { name: implementer, agent: { provider: claude, model: claude-haiku-5-5 } }
  - id: b
    role: { name: reviewer, agent: { provider: claude, model: claude-haiku-5-5 } }
  - id: finish
    needs: [a, b]
    gate: { question: Done? }
`,
  );
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, store, runtime, ...fake };
}

const manager = { id: "m", workspaceId: "ws", cwd: "/" };

describe("start_playbook autoStart", () => {
  it("starts every ready agent step through start_step's path", async () => {
    const { runtime, store, created } = await setup();
    const run = await runtime.startPlaybook(manager, "two", {});
    const auto = await runtime.autoStartReady("m", run.id);
    expect(auto.failed).toEqual([]);
    expect(auto.started.map((s) => s.stepId)).toEqual(["a", "b"]);
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.config.provider)).toEqual(["claude/claude-haiku-5-5", "claude/claude-haiku-5-5"]);
    expect(store.get(run.id)!.steps.a!.status).toBe("running");
  });

  it("leaves the steps ready when it is not called (autoStart: false)", async () => {
    const { runtime, store, created } = await setup();
    const run = await runtime.startPlaybook(manager, "two", {});
    expect(created).toHaveLength(0);
    expect(store.get(run.id)!.steps.a!.status).toBe("ready");
  });

  it("does not double start: the manager's own start_step is refused, and a second autoStart starts nothing", async () => {
    const { runtime, created } = await setup();
    const run = await runtime.startPlaybook(manager, "two", {});
    await runtime.autoStartReady("m", run.id);
    await expect(runtime.startStep("m", run.id, "a", "again")).rejects.toThrow(/running, not ready/);
    expect((await runtime.autoStartReady("m", run.id)).started).toEqual([]);
    expect(created).toHaveLength(2);
  });

  it("tells the manager the steps are started, or not, in its kickoff", async () => {
    const dir = (await setup()).dir;
    const playbook = (await loadPlaybooks(dir)).entries.find((e) => e.id === "two")!.playbook!;
    expect(managerKickoff(playbook, {})).toMatch(/starts the ready agent steps itself/);
    expect(managerKickoff(playbook, {}, false)).toMatch(/autoStart: false[\s\S]*unstarted/);
  });
});
