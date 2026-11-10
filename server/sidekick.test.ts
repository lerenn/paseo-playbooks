import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { SIDEKICK_LABEL, SIDEKICK_PROMPT } from "./sidekick";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakePaseo() {
  const archivedAt: Record<string, string | null> = {};
  const created = { workspaces: [] as unknown[], agents: [] as unknown[] };
  const ref = (agentId: string) => ({
    refresh: async () => (agentId in archivedAt ? { agent: { id: agentId, status: "idle", archivedAt: archivedAt[agentId] } } : null),
    send: async () => undefined,
  });
  const workspace = (id: string) => ({
    id,
    refresh: async () => ({ id }),
    agents: {
      create: async (options: unknown) => {
        created.agents.push({ workspaceId: id, options });
        const agentId = `agent-${created.agents.length}`;
        archivedAt[agentId] = null;
        return { id: agentId, ...ref(agentId) };
      },
    },
  });
  const paseo = {
    agents: { ref },
    workspaces: {
      ref: (id: string) => workspace(id),
      create: async (options: unknown) => {
        created.workspaces.push(options);
        return workspace(`ws-${created.workspaces.length}`);
      },
    },
  };
  return { paseo, created, archive: (id: string) => (archivedAt[id] = new Date().toISOString()) };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "sidekick-"));
  temps.push(dir);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo();
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { runtime, dir, ...fake };
}

describe("the Sidekick", () => {
  it("is created in a hidden background workspace with no code tools, subscribed to escalations", async () => {
    const { runtime, created, dir } = await setup();
    const opened = await runtime.openSidekick();
    expect(opened).toEqual({ workspaceId: "ws-1", agentId: "agent-1", created: true });
    expect(created.workspaces[0]).toMatchObject({ internal: true, background: true, source: { kind: "directory", path: path.join(dir, "sidekick") } });
    const agent = created.agents[0] as { options: { labels: Record<string, string>; config: { options: { allowedTools: string[]; disallowedTools: string[] } }; prompt: string } };
    expect(agent.options.labels[SIDEKICK_LABEL]).toBe("true");
    expect(agent.options.config.options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    expect(agent.options.config.options.allowedTools).toEqual(expect.arrayContaining(["mcp__paseo__create_agent", "mcp__paseo__list_gates"]));
    expect(agent.options.prompt).toContain(SIDEKICK_PROMPT);
    const subscriptions = await runtime.bus.list("agent-1");
    expect(JSON.stringify(subscriptions)).toContain("gate.escalated");
  });

  it("is reused while alive, shared by concurrent opens, and recreated in the same workspace once archived", async () => {
    const { runtime, created, archive } = await setup();
    const [a, b] = await Promise.all([runtime.openSidekick(), runtime.openSidekick()]);
    expect(b).toEqual(a);
    expect(created.agents).toHaveLength(1);
    expect(await runtime.openSidekick()).toMatchObject({ agentId: "agent-1", created: false });
    archive("agent-1");
    expect(await runtime.openSidekick()).toEqual({ workspaceId: "ws-1", agentId: "agent-2", created: true });
    expect(created.workspaces).toHaveLength(1);
  });
});
