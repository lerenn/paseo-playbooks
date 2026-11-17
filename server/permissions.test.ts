import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { COMMAND_RULE, MANAGER_PROTOCOL, stepSystemPrompt } from "./prompts";
import type { Run } from "../shared/types";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Request = { id: string; name: string; kind: string; title?: string; input?: unknown };
type Answer = { agentId: string; requestId: string; behavior: string; message?: string };

/** Just enough of the daemon API: agents with pending permissions, and the answers given to them. */
function fakePaseo(dir: string) {
  const answers: Answer[] = [];
  const pending = new Map<string, Request[]>();
  const parents = new Map<string, string | null>();
  const archived: string[] = [];
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "running", provider: "claude", model: null, archivedAt: archived.includes(agentId) ? "now" : null, parentAgentId: parents.get(agentId) ?? null, pendingPermissions: pending.get(agentId) ?? [] } }),
    send: async () => undefined,
    reload: async () => undefined,
    timeline: { refetch: async () => ({ entries: [], hasOlder: false, startCursor: null }) },
    archive: async () => void archived.push(agentId),
    respondToPermission: async (input: { requestId: string; response: { behavior: string; message?: string } }) => {
      answers.push({ agentId, requestId: input.requestId, behavior: input.response.behavior, ...(input.response.message ? { message: input.response.message } : {}) });
      pending.set(agentId, (pending.get(agentId) ?? []).filter((request) => request.id !== input.requestId));
    },
  });
  const create = async () => ({ id: `agent${++agents}`, send: async () => undefined });
  const paseo = {
    agents: {
      ref,
      list: async () => ({ entries: [...pending.keys()].map((id) => ({ agent: { id, parentAgentId: parents.get(id) ?? null, archivedAt: null, pendingPermissions: pending.get(id) } })) }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: dir }), agents: { create } }) },
  };
  return { paseo, answers, pending, parents, archived };
}

const PLAYBOOK = (permissions = "") => `
title: Main
${permissions}
steps:
  - id: work
    role: { name: implementer }
`;

async function setup(files: Record<string, string>, defaults?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "perm-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  if (defaults) await writeFile(path.join(root, "defaults/main.yaml"), defaults);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, store, runtime, ...fake };
}

const manager = { id: "m", workspaceId: "ws", cwd: "/" };
const bash = (id: string, command = "cd /w && sed -i s/a/b/ f && rm -rf .tmp/*"): Request => ({ id, name: "Bash", kind: "tool", input: { command } });
const history = (run: Run) => run.history.filter((entry) => entry.type.startsWith("permission_"));

async function started(permissions = "", defaults?: string) {
  const ctx = await setup({ "main.yaml": PLAYBOOK(permissions) }, defaults);
  const run = await ctx.runtime.startPlaybook(manager, "main", {});
  const { agentId } = await ctx.runtime.startStep("m", run.id, "work", "");
  return { ...ctx, run, agentId };
}

describe("permissions.on_request", () => {
  it("is authorize by default: a step agent's request is allowed for the human and logged", async () => {
    const { runtime, store, run, agentId, answers } = await started();
    expect(run.playbook.permissions.onRequest).toBe("authorize");
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, bash("r1"));
    expect(answers).toEqual([{ agentId, requestId: "r1", behavior: "allow" }]);
    const [entry] = history(store.get(run.id)!);
    expect(entry).toMatchObject({ type: "permission_authorized", stepId: "work" });
    expect(entry!.detail).toContain("plugin policy (permissions.on_request)");
    expect(entry!.detail).toContain("rm -rf");
    expect(store.get(run.id)!.gates).toHaveLength(0);
  });

  it("answers a request once, however many times it is announced", async () => {
    const { runtime, agentId, answers } = await started();
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, bash("r1"));
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, bash("r1"));
    expect(answers).toHaveLength(1);
  });

  it("deny: answers deny with a message telling the agent to pick another way", async () => {
    const { runtime, store, run, agentId, answers } = await started("permissions: { on_request: deny }");
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, bash("r1"));
    expect(answers[0]).toMatchObject({ behavior: "deny" });
    expect(answers[0]!.message).toMatch(/pick another way/);
    expect(history(store.get(run.id)!)[0]).toMatchObject({ type: "permission_denied" });
  });

  it("does not touch a question, a plan or a request of an agent outside the runs", async () => {
    const { runtime, agentId, answers, store, run } = await started();
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, { id: "q", name: "AskUserQuestion", kind: "question" });
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, { id: "p", name: "ExitPlanMode", kind: "plan" });
    await runtime.onPermissionRequested({ id: "stranger", parentAgentId: null }, bash("r2"));
    expect(answers).toEqual([]);
    expect(history(store.get(run.id)!)).toEqual([]);
  });

  it.each([
    ["the manager", () => ({ id: "m", parentAgentId: null }), "manager"],
    ["a subagent of a step agent", (agentId: string) => ({ id: "kid", parentAgentId: agentId }), "work"],
    ["a subagent of the manager", () => ({ id: "kid", parentAgentId: "m" }), "manager"],
  ])("covers %s", async (_name, who, stepId) => {
    const { runtime, store, run, agentId, answers, parents } = await started();
    const agent = who(agentId);
    parents.set(agent.id, agent.parentAgentId);
    await runtime.onPermissionRequested(agent, bash("r1"));
    expect(answers).toEqual([{ agentId: agent.id, requestId: "r1", behavior: "allow" }]);
    expect(history(store.get(run.id)!)[0]!.stepId).toBe(stepId);
  });

  it("covers the role agent of a gate", async () => {
    const ctx = await setup({ "main.yaml": "title: Main\nsteps:\n  - id: g\n    gate: { question: ok? }\n" });
    const run = await ctx.runtime.startPlaybook(manager, "main", {});
    await ctx.runtime.requestGate("m", run.id, "g", "ok?", "");
    await ctx.store.mutate(run.id, (current) => void (current.gates[0]!.deciderAgentId = "advisor"));
    await ctx.runtime.onPermissionRequested({ id: "advisor", parentAgentId: null }, bash("r1"));
    expect(ctx.answers).toHaveLength(1);
  });

  it("a request of an agent whose run ended is left alone", async () => {
    const { runtime, run, agentId, answers } = await started();
    await runtime.cancelRun(run.id, "stop", null);
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, bash("r1"));
    expect(answers).toEqual([]);
  });

  it("a playbook overrides the repository default", async () => {
    const both = await started("permissions: { on_request: deny }", "permissions: { on_request: escalate }");
    expect(both.run.playbook.permissions.onRequest).toBe("deny");
    const repo = await started("", "permissions: { on_request: escalate }");
    expect(repo.run.playbook.permissions.onRequest).toBe("escalate");
  });

  it("a request raised while the plugin was away is handled by the sweep", async () => {
    const { runtime, agentId, answers, pending } = await started();
    pending.set(agentId, [bash("late")]);
    await (runtime as unknown as { sweepPermissions(scan: boolean): Promise<void> }).sweepPermissions(true);
    expect(answers).toEqual([{ agentId, requestId: "late", behavior: "allow" }]);
  });
});

describe("permissions.on_request: escalate", () => {
  const request = bash("r1", "rm -rf /tmp/x");

  async function escalated() {
    const ctx = await started("permissions: { on_request: escalate }");
    ctx.pending.set(ctx.agentId, [request]);
    await ctx.runtime.onPermissionRequested({ id: ctx.agentId, parentAgentId: null }, request);
    const run = ctx.store.get(ctx.run.id)!;
    return { ...ctx, run, gate: run.gates[0]! };
  }

  it("opens a human gate on the run, naming the agent and the command, and answers nothing yet", async () => {
    const { run, gate, answers, runtime } = await escalated();
    expect(answers).toEqual([]);
    expect(gate).toMatchObject({ kind: "permission", status: "pending", stepId: "work", decider: { by: "human" } });
    expect(gate.summary).toContain("rm -rf /tmp/x");
    expect(gate.details).toContain("Bash");
    expect(run.status).toBe("waiting_gate");
    expect(history(run)[0]).toMatchObject({ type: "permission_escalated" });
    const listed = runtime.attention().gates;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: "permission", waitingForHuman: true, heldBy: "human" });
    expect(listed[0]!.choices.map((choice) => choice.id)).toEqual(["allow", "deny"]);
  });

  it("does not open a second gate for the same request", async () => {
    const { runtime, agentId, store, run } = await escalated();
    (runtime as unknown as { permissionsHandled: Set<string> }).permissionsHandled.clear();
    await runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, request);
    expect(store.get(run.id)!.gates).toHaveLength(1);
  });

  it("allow from the panel answers the request and the run goes on", async () => {
    const { runtime, store, run, gate, agentId, answers } = await escalated();
    await runtime.decideGate(run.id, gate.id, { decision: "allow", comment: null, by: "Louis", via: "panel", now: new Date().toISOString() });
    expect(answers).toEqual([{ agentId, requestId: "r1", behavior: "allow" }]);
    const after = store.get(run.id)!;
    expect(after.gates[0]).toMatchObject({ status: "allow", decidedBy: "Louis", decidedVia: "panel" });
    expect(after.status).toBe("running");
    expect(history(after).map((entry) => entry.type)).toEqual(["permission_escalated", "permission_authorized"]);
  });

  it("deny carries the human's comment to the agent", async () => {
    const { runtime, run, gate, answers } = await escalated();
    await runtime.decideGate(run.id, gate.id, { decision: "deny", comment: "too broad", by: "Louis", via: "panel", now: new Date().toISOString() });
    expect(answers[0]).toMatchObject({ behavior: "deny" });
    expect(answers[0]!.message).toContain("too broad");
  });

  it("is answerable with resume_gate by an agent outside the runs, and never by the manager", async () => {
    const { runtime, store, run, gate, answers } = await escalated();
    await expect(runtime.resumeGateOnBehalf({ id: "m", title: null, parentAgentId: null }, { runId: run.id, gateId: gate.id, choice: "allow", comment: "ok" })).rejects.toThrow(/outside the runs/);
    await expect(runtime.decideGate(run.id, gate.id, { decision: "allow", comment: "ok", by: null, via: "manager", now: new Date().toISOString() })).rejects.toThrow(/human decides/);
    const result = await runtime.resumeGateOnBehalf({ id: "coord", title: "Coordinator", parentAgentId: null }, { runId: run.id, gateId: gate.id, choice: "allow", comment: "Louis said yes" });
    expect(result.gate).toMatchObject({ status: "allow", decidedBy: "agent Coordinator on behalf of the human" });
    expect(answers).toHaveLength(1);
    expect(store.get(run.id)!.status).toBe("running");
  });

  it("refuses a choice the gate does not have", async () => {
    const { runtime, run, gate } = await escalated();
    await expect(runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: null, via: "panel", now: new Date().toISOString() })).rejects.toThrow(/not a choice/);
  });

  it("closes the gate when the request disappears before it is decided", async () => {
    const { runtime, store, run, agentId, pending, answers } = await escalated();
    pending.set(agentId, []);
    await runtime.watchEvents();
    const closed = store.get(run.id)!;
    expect(closed.gates[0]).toMatchObject({ status: "dismissed", decidedBy: "plugin policy (permissions.on_request)" });
    expect(closed.status).toBe("running");
    expect(answers).toEqual([]);
  });

  it("closes the gate when the daemon reports the request resolved, or the agent archived", async () => {
    const first = await escalated();
    await first.runtime.onPermissionResolved(first.agentId, "r1");
    expect(first.store.get(first.run.id)!.gates[0]!.status).toBe("dismissed");
    const second = await escalated();
    await second.runtime.onAgentArchived(second.agentId);
    expect(second.store.get(second.run.id)!.gates[0]!.status).toBe("dismissed");
  });

  it("is a gate like the others for attention: the run is blocked on a human until it is decided", async () => {
    const { runtime, run, gate } = await escalated();
    expect(runtime.attention().gates).toHaveLength(1);
    await runtime.decideGate(run.id, gate.id, { decision: "allow", comment: null, by: null, via: "panel", now: new Date().toISOString() });
    expect(runtime.attention().gates).toHaveLength(0);
  });
});

describe("loading permissions", () => {
  async function load(playbook: string, defaults?: string) {
    const ctx = await setup({ "main.yaml": playbook }, defaults);
    return (await loadPlaybooks(ctx.dir)).entries[0]!;
  }

  it("defaults to authorize", async () => {
    expect((await load(PLAYBOOK())).playbook!.permissions).toEqual({ onRequest: "authorize" });
  });

  it("refuses an unknown value and a mistyped key, in a playbook and in the defaults", async () => {
    expect((await load(PLAYBOOK("permissions: { on_request: always }"))).errors.join("\n")).toMatch(/on_request/);
    expect((await load(PLAYBOOK("permissions: { on_requests: deny }"))).errors.join("\n")).toMatch(/permissions/);
    const bad = await load(PLAYBOOK(), "permissions: { on_request: maybe }\n");
    expect(bad.errors.join("\n")).toMatch(/on_request/);
  });
});

describe("prompts", () => {
  it("tell agents to keep commands simple", () => {
    expect(MANAGER_PROTOCOL).toContain(COMMAND_RULE);
    expect(COMMAND_RULE).toMatch(/rm -rf/);
  });

  it("reach the step agents", async () => {
    const { run } = await started();
    expect(stepSystemPrompt(run.playbook, run.playbook.steps[0]!, run.playbook.roles.implementer!)).toContain(COMMAND_RULE);
  });
});
