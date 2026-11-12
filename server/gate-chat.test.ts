import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const playbook = (mode: string, archive: boolean) => `
title: Chat
manager: { mode: ${mode} }
steps:
  - id: build
    role: { name: implementer, archive_agents: ${archive} }
  - id: approve
    needs: [build]
    gate: { question: Ship it? }
  - id: ship
    needs: [approve]
    role: { name: implementer }
`;

function fakePaseo(dir: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived: string[] = [];
  const denied: Array<{ agentId: string; message: string }> = [];
  const questions = new Set<string>();
  let created = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({
      agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: archived.includes(agentId) ? "now" : null, pendingPermissions: questions.has(agentId) ? [{ id: `q-${agentId}`, kind: "question" }] : [] },
    }),
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => void archived.push(agentId),
    reload: async () => undefined,
    timeline: { refetch: async () => ({ entries: [] }) },
    respondToPermission: async ({ response }: { response: { message: string } }) => void denied.push({ agentId, message: response.message }),
  });
  const workspace = {
    id: "ws",
    projectId: "p",
    workspaceDirectory: dir,
    agents: { create: async () => ({ id: `agent${++created}`, send: async (text: string) => void sent.push({ agentId: `agent${created}`, text }) }) },
  };
  return { paseo: { agents: { ref, list: async () => ({ entries: [] }) }, workspaces: { ref: () => ({ ...workspace, refresh: async () => workspace }) }, providers: { listModels: async () => ({ models: [{ id: "claude-haiku-5-5" }] }) } }, sent, archived, denied, questions };
}

async function setup(mode = "none", archive = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "gc-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "chat.yaml"), playbook(mode, archive));
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  const run = await runtime.startPlaybook({ id: "caller", workspaceId: "ws", cwd: "/" }, "chat", {});
  await runtime.report("agent1", { outcome: "success", summary: "built", outputs: {} });
  await runtime.onStepTurnEnded(run.id, "agent1", "completed");
  return { store, runtime, run, ...fake };
}

const now = () => new Date().toISOString();
const toAgent = (sent: Array<{ agentId: string; text: string }>, id: string) => sent.filter((entry) => entry.agentId === id && entry.text.includes("answer_gate"));

describe("gate question in the step agent's conversation (manager.mode: none)", () => {
  it("asks the live preceding agent once, and the human's answer closes the gate", async () => {
    const { store, runtime, run, sent } = await setup();
    const gate = store.get(run.id)!.gates[0]!;
    expect(gate).toMatchObject({ status: "pending", chatAgentId: "agent1" });
    expect(toAgent(sent, "agent1")).toHaveLength(1);
    expect(toAgent(sent, "agent1")[0]!.text).toMatch(/AskUserQuestion[\s\S]*Ship it\?[\s\S]*"approved"/);
    await runtime.onTurnEnded("agent1", "completed");
    expect(toAgent(sent, "agent1")).toHaveLength(1);
    expect(await runtime.answerGateFromChat("agent1", { gateId: gate.id, decision: "approved", comment: "go" })).toMatch(/Recorded "approved"/);
    const after = store.get(run.id)!;
    expect(after.gates[0]).toMatchObject({ status: "approved", decidedVia: "chat", comment: "go" });
    expect(after.steps.ship!.status).toBe("running");
    // The panel is late: stale, cleanly.
    const late = await runtime.decideGate(run.id, gate.id, { decision: "rejected", comment: null, by: "me", via: "panel", now: now() });
    expect(late.alreadyDecided).toBe(true);
  });

  it("the panel decides first: the open question is dismissed and a later answer is stale", async () => {
    const { store, runtime, run, denied, questions } = await setup();
    const gate = store.get(run.id)!.gates[0]!;
    questions.add("agent1");
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: "me", via: "panel", now: now() });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.message).toMatch(/closed in the Playbooks panel[\s\S]*Do not call answer_gate/);
    expect(store.get(run.id)!.gates[0]!.chatClosed).toBe(true);
    expect(await runtime.answerGateFromChat("agent1", { gateId: gate.id, decision: "rejected", comment: null })).toMatch(/already decided \(approved via panel\)/);
    expect(store.get(run.id)!.gates[0]!.status).toBe("approved");
  });

  it("an answer that is not a choice is refused and leaves the gate open", async () => {
    const { store, runtime, run } = await setup();
    const gate = store.get(run.id)!.gates[0]!;
    await expect(runtime.answerGateFromChat("agent1", { gateId: gate.id, decision: "maybe", comment: null })).rejects.toThrow(/not a choice/);
    expect(store.get(run.id)!.gates[0]!.status).toBe("pending");
  });

  it("only the agent that was asked may answer", async () => {
    const { runtime, store, run } = await setup();
    await expect(runtime.answerGateFromChat("agent9", { gateId: store.get(run.id)!.gates[0]!.id, decision: "approved", comment: null })).rejects.toThrow(/nothing to answer/);
  });

  it("with no live agent (archived when its step completed) only the panel has the gate", async () => {
    const { store, sent } = await setup("none", true);
    const run = store.list()[0]!;
    expect(run.gates[0]).toMatchObject({ status: "pending" });
    expect(run.gates[0]!.chatAgentId ?? null).toBeNull();
    expect(toAgent(sent, "agent1")).toHaveLength(0);
  });

  it("always_on runs are untouched: the manager asks, no agent is prompted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gc-"));
    temps.push(dir);
    const root = path.join(dir, ".paseo/plugins/playbooks");
    await mkdir(root, { recursive: true });
    await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
    await writeFile(path.join(root, "chat.yaml"), playbook("always_on", false));
    const store = new RunStore(path.join(dir, "runs"));
    await store.init();
    const fake = fakePaseo(dir);
    const runtime = new Runtime(store);
    runtimes.push(runtime);
    await runtime.attach(fake.paseo as never);
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "chat", {});
    await runtime.autoStartReady("m", run.id);
    await runtime.report("agent1", { outcome: "success", summary: "built", outputs: {} });
    await runtime.onStepTurnEnded(run.id, "agent1", "completed");
    await runtime.completeStep("m", run.id, "build", { outcome: "success" });
    await runtime.requestGate("m", run.id, "approve", "ok", "");
    expect(toAgent(fake.sent, "agent1")).toHaveLength(0);
    expect(store.get(run.id)!.gates[0]!.chatAgentId ?? null).toBeNull();
  });
});
