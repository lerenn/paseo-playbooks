import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import type { Run } from "../shared/types";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Request = { id: string; name: string; kind: string; title?: string; input?: unknown };
type Answer = { agentId: string; requestId: string; behavior: string; message?: string; updatedInput?: unknown };

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
    respondToPermission: async (input: { requestId: string; response: { behavior: string; message?: string; updatedInput?: unknown } }) => {
      if (!(pending.get(agentId) ?? []).some((request) => request.id === input.requestId)) throw new Error("no such request");
      answers.push({ agentId, requestId: input.requestId, behavior: input.response.behavior, ...(input.response.message ? { message: input.response.message } : {}), ...(input.response.updatedInput ? { updatedInput: input.response.updatedInput } : {}) });
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
  - id: check
    gate: { question: ok? }
`;

async function setup(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "mq-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
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

const manager = { id: "m", workspaceId: "ws", cwd: "/" };
const now = () => new Date().toISOString();
const asking = (id: string, questions: unknown[] = [{ question: "Which environment?", header: "Env", multiSelect: false, options: [{ label: "staging", description: "the safe one" }, { label: "production" }] }]): Request => ({
  id,
  name: "AskUserQuestion",
  kind: "question",
  input: { questions },
});
const MGR = { id: "m", parentAgentId: null };

async function started(permissions = "") {
  const ctx = await setup({ "main.yaml": PLAYBOOK(permissions) });
  const run = await ctx.runtime.startPlaybook(manager, "main", {});
  return { ...ctx, run };
}

async function asked(request: Request = asking("q1"), permissions = "") {
  const ctx = await started(permissions);
  ctx.pending.set("m", [request]);
  await ctx.runtime.onPermissionRequested(MGR, request);
  const gate = ctx.store.get(ctx.run.id)!.gates.find((candidate) => candidate.kind === "manager_question")!;
  return { ...ctx, gate };
}

describe("manager questions as gates", () => {
  it("opens a human gate with the question and its options, listed in list_gates", async () => {
    const { runtime, store, run, gate } = await asked();
    expect(gate).toMatchObject({ kind: "manager_question", stepId: "manager", status: "pending", summary: "Which environment?", decider: { by: "human" } });
    expect(gate.details).toContain("- staging: the safe one");
    expect(gate.details).toContain("- production");
    expect(store.get(run.id)!.status).toBe("waiting_gate");
    const [listed] = runtime.attention().gates;
    expect(listed).toMatchObject({ gateId: gate.id, kind: "manager_question", question: "Which environment?", waitingForHuman: true, heldBy: "human", managerAgentId: "m" });
    expect(listed!.choices.map((choice) => choice.label)).toEqual(["staging", "production", "Something else"]);
  });

  it("preserves recommendation labels and descriptions, and exposes a typed Other answer", async () => {
    const choices = [
      { label: "Use staging (Recommended)", description: "Verify there before production." },
      { label: "Use production", description: "Skip the staging check." },
    ];
    const { runtime, run, gate, answers } = await asked(asking("q-rec", [{ question: "Which environment?", options: choices }]));
    expect(gate.question?.options).toEqual(choices);
    const listed = runtime.attention().gates.find((item) => item.gateId === gate.id);
    expect(listed?.choices).toEqual([
      { id: "option-1", label: "Use staging (Recommended)", comment: "none" },
      { id: "option-2", label: "Use production", comment: "none" },
      { id: "other", label: "Something else", comment: "required" },
    ]);
    await runtime.decideGate(run.id, gate.id, { decision: "other", comment: "use preview", by: null, via: "panel", now: now() });
    expect(answers[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which environment?": "use preview" } } });
  });

  it("answering an option from the panel delivers it once to the manager's question and clears the gate", async () => {
    const { runtime, store, run, gate, answers } = await asked();
    await runtime.decideGate(run.id, gate.id, { decision: "option-1", comment: null, by: "Louis", via: "panel", now: now() });
    expect(answers).toEqual([{ agentId: "m", requestId: "q1", behavior: "allow", updatedInput: { answers: { "Which environment?": "staging" } } }]);
    const after = store.get(run.id)!;
    expect(after.gates[0]).toMatchObject({ status: "option-1", decidedBy: "Louis", decidedVia: "panel" });
    expect(after.status).toBe("running");
    expect(runtime.attention().gates).toHaveLength(0);
    // The second answer loses: nothing more is delivered.
    const again = await runtime.decideGate(run.id, gate.id, { decision: "option-2", comment: null, by: "Louis", via: "panel", now: now() });
    expect(again.alreadyDecided).toBe(true);
    expect(answers).toHaveLength(1);
  });

  it("'Something else' delivers the typed text and needs it", async () => {
    const { runtime, run, gate, answers } = await asked();
    await expect(runtime.decideGate(run.id, gate.id, { decision: "other", comment: " ", by: null, via: "panel", now: now() })).rejects.toThrow(/needs the answer/);
    await runtime.decideGate(run.id, gate.id, { decision: "other", comment: "the canary", by: null, via: "panel", now: now() });
    expect(answers[0]!.updatedInput).toEqual({ answers: { "Which environment?": "the canary" } });
  });

  it("a free-text question takes a typed answer", async () => {
    const { runtime, run, gate, answers } = await asked(asking("q2", [{ question: "What should the branch be called?", options: [] }]));
    expect(runtime.attention().gates[0]!.choices).toEqual([{ id: "answered", label: "Send answer", comment: "required" }]);
    await runtime.decideGate(run.id, gate.id, { decision: "answered", comment: "feat/login", by: null, via: "panel", now: now() });
    expect(answers[0]!.updatedInput).toEqual({ answers: { "What should the branch be called?": "feat/login" } });
  });

  it("several questions or a multi-select are listed but answered in the manager's conversation", async () => {
    const { runtime, run, gate, answers } = await asked(asking("q3", [{ question: "A?", options: [{ label: "x" }] }, { question: "B?", options: [] }]));
    expect(gate.question!.answerable).toBe(false);
    expect(gate.details).toContain("B?");
    expect(gate.details).toContain("manager's conversation");
    expect(runtime.attention().gates[0]!.choices).toEqual([]);
    await expect(runtime.decideGate(run.id, gate.id, { decision: "option-1", comment: null, by: null, via: "panel", now: now() })).rejects.toThrow(/manager's conversation/);
    expect(answers).toEqual([]);
  });

  it("clears when the question is answered elsewhere (the daemon reports it resolved, or it disappears)", async () => {
    const first = await asked();
    await first.runtime.onPermissionResolved("m", "q1");
    expect(first.store.get(first.run.id)!.gates[0]).toMatchObject({ status: "dismissed" });
    expect(first.store.get(first.run.id)!.status).toBe("running");
    const second = await asked();
    second.pending.set("m", []);
    await second.runtime.watchEvents();
    expect(second.store.get(second.run.id)!.gates[0]!.status).toBe("dismissed");
    expect(second.answers).toEqual([]);
  });

  it("answered in the conversation first: the panel's answer is not delivered a second time", async () => {
    const { runtime, store, run, gate, answers, pending } = await asked();
    pending.set("m", []);
    await runtime.onPermissionResolved("m", "q1");
    const late = await runtime.decideGate(run.id, gate.id, { decision: "option-1", comment: null, by: null, via: "panel", now: now() });
    expect(late.alreadyDecided).toBe(true);
    expect(answers).toEqual([]);
    expect(store.get(run.id)!.gates[0]!.status).toBe("dismissed");
  });

  it("is opened once per request, however often it is announced, and a restart sweep finds a request raised while away", async () => {
    const { runtime, store, run, pending } = await asked();
    await runtime.onPermissionRequested(MGR, asking("q1"));
    expect(store.get(run.id)!.gates).toHaveLength(1);
    pending.set("m", [asking("q1"), asking("q9", [{ question: "Another?", options: [] }])]);
    // The sweep (start-up) announces every pending request again: q1 is known, q9 is new.
    await runtime.onPermissionRequested(MGR, asking("q9", [{ question: "Another?", options: [] }]));
    expect(store.get(run.id)!.gates.map((gate) => gate.summary)).toEqual(["Which environment?", "Another?"]);
  });

  it("does not duplicate a tool permission request under permissions.on_request: escalate", async () => {
    const ctx = await started("permissions: { on_request: escalate }");
    const tool: Request = { id: "t1", name: "Bash", kind: "tool", input: { command: "rm -rf .tmp/*" } };
    ctx.pending.set("m", [tool, asking("q1")]);
    await ctx.runtime.onPermissionRequested(MGR, tool);
    await ctx.runtime.onPermissionRequested(MGR, asking("q1"));
    const kinds = ctx.store.get(ctx.run.id)!.gates.map((gate) => gate.kind);
    expect(kinds).toEqual(["permission", "manager_question"]);
  });

  it("is not opened for a question another gate of the run already carries, nor for a step agent or a subagent", async () => {
    const ctx = await started();
    await ctx.runtime.requestGate("m", ctx.run.id, "check", "Ship it?", "");
    await ctx.runtime.onPermissionRequested(MGR, asking("q1"));
    expect(ctx.store.get(ctx.run.id)!.gates.map((gate) => gate.kind)).toEqual(["gate"]);
    const other = await started();
    const { agentId } = await other.runtime.startStep("m", other.run.id, "work", "");
    other.parents.set("kid", "m");
    await other.runtime.onPermissionRequested({ id: agentId, parentAgentId: null }, asking("q2"));
    await other.runtime.onPermissionRequested({ id: "kid", parentAgentId: "m" }, asking("q3"));
    expect(other.store.get(other.run.id)!.gates).toEqual([]);
  });

  it("ignores a question of a paused or ended run, and one it cannot read", async () => {
    const ended = await started();
    await ended.runtime.cancelRun(ended.run.id, "stop", null);
    await ended.runtime.onPermissionRequested(MGR, asking("q1"));
    expect(ended.store.get(ended.run.id)!.gates).toEqual([]);
    const blank = await started();
    await blank.runtime.onPermissionRequested(MGR, { id: "q2", name: "AskUserQuestion", kind: "question" });
    expect(blank.store.get(blank.run.id)!.gates).toEqual([]);
  });

  it("is answerable with resume_gate by an agent outside the runs, never by the manager", async () => {
    const { runtime, run, gate, answers } = await asked();
    await expect(runtime.decideGate(run.id, gate.id, { decision: "option-2", comment: "ok", by: null, via: "manager", now: now() })).rejects.toThrow(/human answers/);
    const result = await runtime.resumeGateOnBehalf({ id: "coord", title: "Coordinator", parentAgentId: null }, { runId: run.id, gateId: gate.id, choice: "option-2", comment: "Louis said production" });
    expect(result.gate).toMatchObject({ status: "option-2" });
    expect(answers[0]!.updatedInput).toEqual({ answers: { "Which environment?": "production" } });
  });
});
