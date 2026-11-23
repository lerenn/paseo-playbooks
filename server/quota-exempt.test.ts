import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managerTools } from "./tools";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "exempt-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "w.yaml"), "title: W\nsteps:\n  - id: go\n    gate: { question: Go? }\n");
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const workspace = (id: string) => ({ id, projectId: "p", workspaceDirectory: dir });
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { id: "m", status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }), send: async () => undefined }) },
    workspaces: { ref: (id: string) => ({ refresh: async () => workspace(id), agents: { create: async () => ({ id: "x", send: async () => undefined }) } }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  return { store, runtime };
}

describe("a run exempt from quota limiting", () => {
  it("is started by start_playbook's quota block, says so in its history, and is shown by the run listing", async () => {
    const { store, runtime } = await setup();
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "w", {}, { quotaExempt: true });
    expect(store.get(run.id)!.quotaExempt).toBe(true);
    expect(store.get(run.id)!.history.map((entry) => entry.detail).join("\n")).toContain("quota: exempt");
    const plain = await runtime.startPlaybook({ id: "m", workspaceId: "ws2", cwd: "/" }, "w", {});
    expect(store.get(plain.id)!.quotaExempt).toBe(false);
    expect(store.get(plain.id)!.history.map((entry) => entry.detail).join("\n")).not.toContain("quota: exempt");
  });

  it("is passed to the child runs of an exempt parent, and not to those of another", async () => {
    const { store, runtime } = await setup();
    const parent = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "w", {}, { quotaExempt: true });
    const other = await runtime.startPlaybook({ id: "m", workspaceId: "ws2", cwd: "/" }, "w", {});
    const playbook = parent.playbook;
    const inner = runtime as unknown as { addReservation(workspaceId: string, reservation: unknown): void };
    inner.addReservation("ws3", { runId: "child1", branch: null, playbook, inputs: {}, parent: { runId: parent.id, stepId: "go", key: "k" } });
    inner.addReservation("ws4", { runId: "child2", branch: null, playbook, inputs: {}, parent: { runId: other.id, stepId: "go", key: "k" } });
    const child1 = await runtime.startPlaybook({ id: "m", workspaceId: "ws3", cwd: "/" }, "w", {}, { playbook });
    const child2 = await runtime.startPlaybook({ id: "m", workspaceId: "ws4", cwd: "/" }, "w", {}, { playbook });
    expect(store.get(child1.id)!.quotaExempt).toBe(true);
    expect(store.get(child2.id)!.quotaExempt).toBe(false);
  });
});

describe("start_playbook's quota block", () => {
  const input = async () => {
    const { runtime } = await setup();
    const tool = managerTools(runtime).find((candidate) => candidate.name === "start_playbook")!;
    return (tool as unknown as { input: { safeParse(value: unknown): { success: boolean } } }).input;
  };

  it("accepts quota: { exempt: true }, keeps the flat priority, and refuses anything else in the block", async () => {
    const schema = await input();
    expect(schema.safeParse({ playbook: "w", quota: { exempt: true } }).success).toBe(true);
    expect(schema.safeParse({ playbook: "w", quota: {} }).success).toBe(true);
    expect(schema.safeParse({ playbook: "w", priority: 5, quota: { exempt: false } }).success).toBe(true);
    expect(schema.safeParse({ playbook: "w" }).success).toBe(true);
    expect(schema.safeParse({ playbook: "w", quota: { exempt: "yes" } }).success).toBe(false);
    expect(schema.safeParse({ playbook: "w", quota: true }).success).toBe(false);
  });
});
