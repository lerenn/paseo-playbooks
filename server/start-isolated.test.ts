import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { managerTools } from "./tools";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const STEPS = "steps:\n  - id: a\n    role: { name: implementer, agent: { provider: claude, model: claude-haiku-5-5 } }\n";

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "start-iso-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "iso.yaml"), `title: Iso\nisolation: { mode: worktree }\ninputs:\n  n: { type: string, default: x }\n${STEPS}`);
  await writeFile(path.join(root, "plain.yaml"), `title: Plain\ninputs:\n  n: { type: string, default: x }\n${STEPS}`);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const managers: Array<{ workspaceId: string; title: string }> = [];
  const newWorkspaces: string[] = [];
  const workspaceFor = (id: string) => ({
    id,
    projectId: "p",
    workspaceDirectory: dir,
    projectRootPath: dir,
    agents: {
      create: async (input: { title: string }) => {
        managers.push({ workspaceId: id, title: input.title });
        return { id: `mgr-${managers.length}`, send: async () => undefined };
      },
    },
  });
  const paseo = {
    agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }), send: async () => undefined, archive: async () => undefined }) },
    workspaces: {
      ref: (id: string) => ({ ...workspaceFor(id), refresh: async () => workspaceFor(id) }),
      create: async () => {
        const id = `new-${newWorkspaces.length + 1}`;
        newWorkspaces.push(id);
        return workspaceFor(id);
      },
    },
    providers: { listModels: async (provider: string) => ({ provider, models: [{ id: "claude-haiku-5-5" }] }) },
  };
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(paseo as never);
  vi.spyOn(runtime, "isSidekick").mockImplementation(async (id: string) => id === "sidekick");
  const start = managerTools(runtime).find((tool) => tool.name === "start_playbook")!;
  const call = (agentId: string, workspaceId: string | null, input: Record<string, unknown>) =>
    (start.execute as (input: unknown, ctx: unknown) => Promise<{ isError?: boolean; text: string; structuredContent?: { workspaceId: string } }>)(
      { inputs: {}, autoStart: true, ...input },
      { agent: { id: agentId, workspaceId, cwd: dir } },
    );
  return { call, managers, newWorkspaces };
}

describe("start_playbook and isolation: worktree", () => {
  it("starts an isolated playbook in the caller's workspace, newWorkspace omitted or false", async () => {
    const { call, managers, newWorkspaces } = await setup();
    for (const [n, extra] of [["1", {}], ["2", { newWorkspace: false }]] as const) {
      const result = await call("agent", "ws-user", { playbook: "iso", inputs: { n }, ...extra });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.workspaceId).toBe("ws-user");
    }
    expect(newWorkspaces).toEqual([]);
    expect(managers.map((m) => m.workspaceId)).toEqual(["ws-user", "ws-user"]);
  });

  it("lets two isolated runs share one workspace (each with its own manager)", async () => {
    const { call, managers } = await setup();
    const a = await call("agent", "ws-user", { playbook: "iso", inputs: { n: "1" } });
    const b = await call("agent", "ws-user", { playbook: "iso", inputs: { n: "2" } });
    expect(a.isError).toBeFalsy();
    expect(b.text).toMatch(/starting/);
    expect(managers).toHaveLength(2);
    expect(managers.every((m) => m.workspaceId === "ws-user")).toBe(true);
  });

  it("uses workspaceId instead of the caller's workspace", async () => {
    const { call, newWorkspaces } = await setup();
    const result = await call("agent", "ws-user", { playbook: "iso", workspaceId: "ws-other" });
    expect(result.structuredContent?.workspaceId).toBe("ws-other");
    expect(newWorkspaces).toEqual([]);
  });

  it("newWorkspace: true forces a new workspace", async () => {
    const { call, newWorkspaces } = await setup();
    const result = await call("agent", "ws-user", { playbook: "iso", newWorkspace: true });
    expect(result.isError).toBeFalsy();
    expect(newWorkspaces).toEqual(["new-1"]);
    expect(result.structuredContent?.workspaceId).toBe("new-1");
  });

  it("a playbook without isolation still always starts in a new workspace, and newWorkspace: false is refused", async () => {
    const { call, newWorkspaces, managers } = await setup();
    const result = await call("agent", "ws-user", { playbook: "plain" });
    expect(result.structuredContent?.workspaceId).toBe("new-1");
    const refused = await call("agent", "ws-user", { playbook: "plain", newWorkspace: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/isolation: \{ mode: worktree \}/);
    expect(newWorkspaces).toEqual(["new-1"]);
    expect(managers.map((m) => m.workspaceId)).toEqual(["new-1"]);
  });

  it("a Sidekick still gets a new workspace, even for an isolated playbook, unless it passes an existing workspaceId", async () => {
    const { call, newWorkspaces } = await setup();
    const fresh = await call("sidekick", "ws-hidden", { playbook: "iso" });
    expect(fresh.structuredContent?.workspaceId).toBe("new-1");
    const refused = await call("sidekick", "ws-hidden", { playbook: "iso", newWorkspace: false });
    expect(refused.isError).toBe(true);
    const inPlace = await call("sidekick", "ws-hidden", { playbook: "iso", workspaceId: "ws-user" });
    expect(inPlace.isError).toBeFalsy();
    expect(inPlace.structuredContent?.workspaceId).toBe("ws-user");
    const forced = await call("sidekick", "ws-hidden", { playbook: "iso", workspaceId: "ws-user", newWorkspace: true });
    expect(forced.structuredContent?.workspaceId).toBe("new-2");
    const hidden = await call("sidekick", "ws-hidden", { playbook: "iso", workspaceId: "ws-hidden" });
    expect(hidden.isError).toBe(true);
    expect(newWorkspaces).toEqual(["new-1", "new-2"]);
  });
});
