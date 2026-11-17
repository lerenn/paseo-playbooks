import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatesOnBehalfSetting, loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Just enough of the daemon API: idle agents, recorded prompts and created agents. */
function fakePaseo(dir: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ id: string; labels: Record<string, string>; systemPrompt: string }> = [];
  const archived: string[] = [];
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: archived.includes(agentId) ? "now" : null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
    archive: async () => void archived.push(agentId),
  });
  const create = async (input: { labels: Record<string, string>; config: { systemPrompt: string } }) => {
    const id = `agent${++agents}`;
    created.push({ id, labels: input.labels, systemPrompt: input.config.systemPrompt });
    return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
  };
  const paseo = {
    agents: { ref },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: dir }), agents: { create } }) },
  };
  return { paseo, sent, created, archived };
}

async function setup(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "decider-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, store, runtime, ...fake };
}

const now = () => new Date().toISOString();
const manager = { id: "m", workspaceId: "ws", cwd: "/" };

const HUMAN_GATE = `
title: Main
steps:
  - id: approve
    gate:
      question: Ship it?
`;

describe("resume_gate (Runtime.resumeGateOnBehalf)", () => {
  const coordinator = { id: "coord", title: "Coordinator", parentAgentId: null };
  async function open(defaults?: string) {
    const ctx = await setup({ "main.yaml": HUMAN_GATE });
    if (defaults) {
      await mkdir(path.join(ctx.dir, ".paseo/plugins/playbooks/defaults"), { recursive: true });
      await writeFile(path.join(ctx.dir, ".paseo/plugins/playbooks/defaults/main.yaml"), defaults);
    }
    const registry = (ctx.runtime as unknown as { sidekickRegistry: { findByAgent: (id: string) => Promise<unknown> } }).sidekickRegistry;
    registry.findByAgent = async (id: string) => (id === "sk" ? { projectId: "p", record: {} } : id === "other-sk" ? { projectId: "q", record: {} } : null);
    const run = await ctx.runtime.startPlaybook(manager, "main", {});
    const gate = await ctx.runtime.requestGate("m", run.id, "approve", "Ship it?", "");
    return { ...ctx, run, gate };
  }
  const answer = (run: { id: string }, gate: { id: string }, extra: Record<string, string> = {}) => ({ runId: run.id, gateId: gate.id, choice: "approved", comment: "Yes, ship it", ...extra });

  it("lets an agent outside the runs decide a human gate as a panel click would, recorded with who it was", async () => {
    const { runtime, store, run, gate, sent } = await open();
    const result = await runtime.resumeGateOnBehalf(coordinator, answer(run, gate));
    expect(result.gate).toMatchObject({ status: "approved", decidedVia: "panel", decidedBy: "agent Coordinator on behalf of the human", comment: "Yes, ship it" });
    expect(store.get(run.id)!.gates[0]!.status).toBe("approved");
    expect(sent.filter((entry) => entry.agentId === "m").map((entry) => entry.text).join("\n")).toMatch(/on behalf of the human via panel/);
  });

  it("works for a Sidekick of the run's project", async () => {
    const { runtime, run, gate } = await open();
    expect((await runtime.resumeGateOnBehalf({ id: "sk", title: null, parentAgentId: null }, answer(run, gate))).gate.decidedBy).toBe("agent sk on behalf of the human");
  });

  it("refuses the run's own manager, its step agents and anything they started", async () => {
    const { runtime, store, run, gate } = await open();
    await expect(runtime.resumeGateOnBehalf({ id: "m", title: null, parentAgentId: null }, answer(run, gate))).rejects.toThrow(/outside the runs/);
    await expect(runtime.resumeGateOnBehalf({ id: "kid", title: null, parentAgentId: "m" }, answer(run, gate))).rejects.toThrow(/outside the runs/);
    await store.mutate(run.id, (current) => void (current.gates[0]!.deciderAgentId = "advisor"));
    await expect(runtime.resumeGateOnBehalf({ id: "advisor", title: null, parentAgentId: null }, answer(run, gate))).rejects.toThrow(/outside the runs/);
    expect(store.get(run.id)!.gates[0]!.status).toBe("pending");
  });

  it("refuses a Sidekick of another project", async () => {
    const { runtime, run, gate } = await open();
    await expect(runtime.resumeGateOnBehalf({ id: "other-sk", title: null, parentAgentId: null }, answer(run, gate))).rejects.toThrow(/not a run of this Sidekick's project/);
  });

  it("refuses a gate that is not open", async () => {
    const { runtime, run, gate } = await open();
    await runtime.resumeGateOnBehalf(coordinator, answer(run, gate));
    await expect(runtime.resumeGateOnBehalf(coordinator, answer(run, gate))).rejects.toThrow(/not open/);
  });

  it("refuses a choice the gate does not have, leaving the gate open", async () => {
    const { runtime, store, run, gate } = await open();
    await expect(runtime.resumeGateOnBehalf(coordinator, answer(run, gate, { choice: "maybe" }))).rejects.toThrow(/not a choice/);
    expect(store.get(run.id)!.gates[0]!.status).toBe("pending");
  });

  it("refuses an empty comment", async () => {
    const { runtime, store, run, gate } = await open();
    await expect(runtime.resumeGateOnBehalf(coordinator, answer(run, gate, { comment: "  " }))).rejects.toThrow(/comment is empty/);
    expect(store.get(run.id)!.gates[0]!.status).toBe("pending");
  });

  it("is refused everywhere with gates: { on_behalf: deny }", async () => {
    const { runtime, store, run, gate } = await open("gates: { on_behalf: deny }\n");
    await expect(runtime.resumeGateOnBehalf(coordinator, answer(run, gate))).rejects.toThrow(/turned off/);
    expect(store.get(run.id)!.gates[0]!.status).toBe("pending");
  });
});

describe("defaults gates block", () => {
  it("reads on_behalf (allow by default) and refuses a mistyped key", async () => {
    const { dir } = await setup({ "main.yaml": HUMAN_GATE });
    expect(await gatesOnBehalfSetting(dir)).toBe("allow");
    const file = path.join(dir, ".paseo/plugins/playbooks/defaults/main.yaml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "gates: { on_behalf: deny }\n");
    expect(await gatesOnBehalfSetting(dir)).toBe("deny");
    await writeFile(file, "gates: { on_behalves: deny }\n");
    expect((await loadPlaybooks(dir)).entries[0]!.errors.join("\n")).toMatch(/gates/);
  });
});
