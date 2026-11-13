import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";
import { GATE_LABEL, Runtime } from "./runtime";
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

const ROLE_GATE = `
title: Main
steps:
  - id: approve
    gate:
      question: Ship it?
      decider: { by: role, role: reviewer }
`;

describe("gate deciders: loading", () => {
  async function errorsOf(yaml: string): Promise<string> {
    const { dir } = await setup({ "main.yaml": yaml });
    return (await loadPlaybooks(dir)).entries[0]!.errors.join("\n");
  }

  it("reads a decider on gate steps, asks and loop limits; a human by default", async () => {
    const { dir } = await setup({
      "main.yaml": `
title: Main
steps:
  - id: work
    role: { name: investigator }
    outcomes: [success, unsure, redo]
    on:
      unsure: { ask: "What next?", decider: { by: manager } }
      redo: { goto: work, max_loops: 2, decider: { by: role, role: reviewer } }
  - id: approve
    needs: [work]
    gate: { question: Ship it?, decider: { by: role, role: reviewer } }
  - id: plain
    needs: [approve]
    gate: { question: Really? }
`,
    });
    const playbook = (await loadPlaybooks(dir)).entries[0]!.playbook!;
    const step = (id: string) => playbook.steps.find((candidate) => candidate.id === id)!;
    expect(step("work").on.unsure).toMatchObject({ kind: "ask", decider: { by: "manager" } });
    expect(step("work").on.redo).toMatchObject({ kind: "goto", maxLoops: 2, decider: { by: "role", role: "reviewer" } });
    expect(step("approve").decider).toEqual({ by: "role", role: "reviewer", agent: {} });
    expect(step("plain").decider).toBeUndefined();
    expect(playbook.roles.reviewer).toBeDefined();
  });

  it("refuses a role without by: role, by: role without a role, a role that edits files, an unknown role, and a goto without max_loops", async () => {
    const gate = (decider: string) => `title: M\nsteps:\n  - id: a\n    gate: { question: ok?, decider: ${decider} }\n`;
    expect(await errorsOf(gate("{ by: manager, role: reviewer }"))).toMatch(/gate\.decider\.role: only applies with `by: role`/);
    expect(await errorsOf(gate("{ by: role }"))).toMatch(/`by: role` needs a `role`/);
    expect(await errorsOf(gate("{ by: role, role: implementer }"))).toMatch(/role "implementer" decides gates, so it must be `readonly: true`/);
    expect(await errorsOf(gate("{ by: role, role: ghost }"))).toMatch(/role "ghost"/);
    expect(await errorsOf(gate("{ by: robot }"))).toMatch(/decider/);
    expect(
      await errorsOf("title: M\nsteps:\n  - id: a\n    role: { name: investigator }\n    outcomes: [success, redo]\n    on:\n      redo: { goto: a, decider: { by: manager } }\n"),
    ).toMatch(/on\.redo\.decider: a `goto` opens a gate only with `max_loops`/);
  });
});

describe("gate deciders: a role", () => {
  async function openRoleGate() {
    const ctx = await setup({ "main.yaml": ROLE_GATE });
    const run = await ctx.runtime.startPlaybook(manager, "main", {});
    const gate = await ctx.runtime.requestGate("m", run.id, "approve", "PR #1 is green.", "");
    const decider = ctx.created.find((agent) => agent.labels[GATE_LABEL] === gate.id)!;
    return { ...ctx, run, gate, decider };
  }

  it("starts an agent with the role when the gate opens, and records its decision", async () => {
    const { store, runtime, run, gate, decider, sent, archived } = await openRoleGate();
    const toManager = () => sent.filter((entry) => entry.agentId === "m").map((entry) => entry.text).join("\n");
    expect(gate.deciderAgentId).toBe(decider.id);
    expect(decider.systemPrompt).toMatch(/You are the Reviewer/);
    expect(decider.systemPrompt).toMatch(/report_gate_decision/);
    expect(sent.find((entry) => entry.agentId === decider.id)!.text).toMatch(/Gate approve-1: PR #1 is green\.[\s\S]*"approved": Approve/);

    await expect(runtime.decideGate(run.id, gate.id, { decision: "approved", comment: "ok", by: "manager", via: "manager", now: now() })).rejects.toThrow(/decided by role "reviewer"/);
    expect(await runtime.reportGateDecision(decider.id, { decision: "approved", comment: "Only docs changed." })).toMatch(/recorded/);
    const decided = store.get(run.id)!;
    expect(decided.status).toBe("completed");
    expect(decided.gates[0]).toMatchObject({ status: "approved", decidedVia: "role", decidedBy: "reviewer", comment: "Only docs changed." });
    expect(toManager()).toMatch(/Gate approve approved by role "reviewer": "Only docs changed\."/);
    // Stopped once its turn ends, not during its tool call.
    expect(archived).not.toContain(decider.id);
    await runtime.onTurnEnded(decider.id, "completed");
    expect(archived).toContain(decider.id);
  });

  it("leaves the gate to a human when the role escalates; the manager is told to ask", async () => {
    const { store, runtime, run, gate, decider, sent } = await openRoleGate();
    await runtime.reportGateDecision(decider.id, { decision: "escalate", comment: "It touches billing." });
    const open = store.get(run.id)!.gates[0]!;
    expect(open).toMatchObject({ status: "pending", escalated: "It touches billing." });
    expect(open.details).toMatch(/Left to a human by role "reviewer": It touches billing\./);
    expect(sent.filter((entry) => entry.agentId === "m").map((entry) => entry.text).join("\n")).toMatch(/role "reviewer" left gate approve-1 \("approve"\) to a human: It touches billing\.[\s\S]*Ask the human now/);
    expect(await runtime.reportGateDecision(decider.id, { decision: "approved", comment: "changed my mind" })).toMatch(/already left to a human/);
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: "U123", via: "chat", now: now() });
    expect(store.get(run.id)!.status).toBe("completed");
  });

  it("reminds an agent that ends without a decision once, then escalates", async () => {
    const { store, runtime, run, decider, sent } = await openRoleGate();
    await runtime.onTurnEnded(decider.id, "completed");
    expect(sent.filter((entry) => entry.agentId === decider.id).at(-1)!.text).toMatch(/ended without a decision for gate "approve-1"/);
    expect(store.get(run.id)!.gates[0]!.escalated).toBeNull();
    await runtime.onTurnEnded(decider.id, "completed");
    expect(store.get(run.id)!.gates[0]!.escalated).toBe("its agent ended without a decision");
  });

  it("stops the agent when a human decides first in the panel", async () => {
    const { store, runtime, run, gate, decider, archived } = await openRoleGate();
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: "laptop", via: "panel", now: now() });
    expect(archived).toContain(decider.id);
    expect(store.get(run.id)!.gates[0]!.escalated).toBeNull();
    expect(await runtime.reportGateDecision(decider.id, { decision: "rejected", comment: "late" })).toMatch(/already decided \(approved via panel\)/);
  });
});

describe("gate deciders: the manager", () => {
  it("lets the manager decide an ask with byManager and a reason, and refuses byManager on a human gate", async () => {
    const { store, runtime } = await setup({
      "main.yaml": `
title: Main
steps:
  - id: work
    role: { name: investigator }
    outcomes: [success, unsure]
    on:
      unsure: { ask: "Which way?", decider: { by: manager } }
  - id: approve
    needs: [work]
    gate: { question: Ship it? }
`,
    });
    const run = await runtime.startPlaybook(manager, "main", {});
    const { agentId } = await runtime.startStep("m", run.id, "work", "");
    await runtime.report(agentId, { outcome: "unsure", summary: "two options", outputs: {} });
    await runtime.completeStep("m", run.id, "work", { outcome: "unsure" });
    const ask = store.get(run.id)!.gates[0]!;
    expect(ask.decider).toEqual({ by: "manager" });

    await expect(runtime.decideGate(run.id, ask.id, { decision: "answered", comment: " ", by: "manager", via: "manager", now: now() })).rejects.toThrow(/needs a comment/);
    await runtime.decideGate(run.id, ask.id, { decision: "answered", comment: "Take option A: it is reversible.", by: "manager", via: "manager", now: now() });
    expect(store.get(run.id)!.gates[0]).toMatchObject({ status: "answered", decidedVia: "manager" });

    const { agentId: second } = await runtime.startStep("m", run.id, "work", "");
    await runtime.report(second, { outcome: "success", summary: "done", outputs: {} });
    await runtime.completeStep("m", run.id, "work", { outcome: "success" });
    const gate = await runtime.requestGate("m", run.id, "approve", "Done.", "");
    expect(gate.decider).toEqual({ by: "human" });
    await expect(runtime.decideGate(run.id, gate.id, { decision: "approved", comment: "fine", by: "manager", via: "manager", now: now() })).rejects.toThrow(/decided by a human, not by you/);
  });
});
