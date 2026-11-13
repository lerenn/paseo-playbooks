import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { listAttention } from "./overseer";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  faults.failCreate = false;
  faults.gone.clear();
  faults.running.clear();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const faults = { failCreate: false, gone: new Set<string>(), running: new Set<string>() };

function fakePaseo(dir: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived = new Set<string>();
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => (faults.gone.has(agentId) ? null : { agent: { id: agentId, status: faults.running.has(agentId) ? "running" : "idle", provider: "claude", model: null, archivedAt: archived.has(agentId) ? "now" : null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
    archive: async () => void archived.add(agentId),
  });
  const create = async () => {
    if (faults.failCreate) throw new Error("no capacity");
    const id = `agent${++agents}`;
    return { id, send: async (text: string) => void sent.push({ agentId: id, text }) };
  };
  const paseo = {
    agents: { ref },
    workspaces: { ref: (id: string) => ({ refresh: async () => ({ id, projectId: "p", workspaceDirectory: dir }), agents: { create } }) },
  };
  return { paseo, sent, archived };
}

const PLAYBOOKS: Record<string, string> = {
  "human.yaml": `title: Human\nsteps:\n  - id: approve\n    gate: { question: Ship it?, choices: { approved: { label: Approve }, rejected: { label: Reject, comment: required } } }\n    on: { rejected: fail }\n`,
  "role.yaml": `title: Role\nsteps:\n  - id: approve\n    gate: { question: Ship it?, decider: { by: role, role: reviewer } }\n`,
  "manager.yaml": `title: Manager\nsteps:\n  - id: approve\n    gate: { question: Ship it?, decider: { by: manager } }\n`,
  "flow.yaml": `title: Flow\nsteps:\n  - id: work\n    role: { name: investigator }\n    outcomes: [success, failure]\n    retries: 1\n  - id: wrap\n    role: { name: investigator }\n`,
  "ask.yaml": `title: Ask\nsteps:\n  - id: work\n    role: { name: investigator }\n    outcomes: [success, unsure]\n    on:\n      unsure: { ask: "Which way?", decider: { by: manager } }\n`,
};

async function setup(options: { debounceMs?: number } = {}, existing?: { dir: string; file: string }) {
  const dir = existing?.dir ?? (await mkdtemp(path.join(tmpdir(), "events-")));
  if (!existing) {
    temps.push(dir);
    const root = path.join(dir, ".paseo/plugins/playbooks");
    await mkdir(root, { recursive: true });
    await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
    for (const [name, body] of Object.entries(PLAYBOOKS)) await writeFile(path.join(root, name), body);
  }
  const store = new RunStore(path.join(dir, "data", "runs"));
  await store.init();
  const fake = fakePaseo(dir);
  const runtime = new Runtime(store, { autoStartAgents: false, debounceMs: options.debounceMs ?? 0, pollMs: 3_600_000 });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, store, runtime, ...fake };
}

const now = () => new Date().toISOString();
const mgr = (id: string) => ({ id, workspaceId: `ws-${id}`, cwd: "/" });
const toAgent = (sent: Array<{ agentId: string; text: string }>, id: string) => sent.filter((entry) => entry.agentId === id).map((entry) => entry.text).join("\n");

describe("list_gates", () => {
  it("lists every open gate and ask across runs, with decider and holder, oldest first, and filters", async () => {
    const { runtime, store } = await setup();
    const a = await runtime.startPlaybook(mgr("m1"), "human", {});
    await runtime.requestGate("m1", a.id, "approve", "Ship A?", "");
    const b = await runtime.startPlaybook(mgr("m2"), "role", {});
    await runtime.requestGate("m2", b.id, "approve", "Ship B?", "");
    const c = await runtime.startPlaybook(mgr("m3"), "ask", {});
    const { agentId } = await runtime.startStep("m3", c.id, "work", "");
    await runtime.report(agentId, { outcome: "unsure", summary: "two ways", outputs: {} });
    await runtime.completeStep("m3", c.id, "work", { outcome: "unsure" });
    await store.mutate(a.id, (run) => void (run.gates[0]!.requestedAt = new Date(Date.now() - 45 * 60_000).toISOString()));

    const { gates } = runtime.attention();
    expect(gates.map((gate) => gate.runId)).toEqual([a.id, b.id, c.id]);
    expect(gates[0]).toMatchObject({ playbook: "human", stepId: "approve", kind: "gate", question: "Ship A?", decider: "human", heldBy: "human", roleDeciding: false, waitingForHuman: true, ageMinutes: 45 });
    expect(gates[0]!.choices.map((choice) => choice.id)).toEqual(["approved", "rejected"]);
    expect(gates[0]).not.toHaveProperty("inputs");
    expect(gates[1]).toMatchObject({ decider: "role", deciderRole: "reviewer", heldBy: "role reviewer", roleDeciding: true, waitingForHuman: false });
    expect(gates[2]).toMatchObject({ kind: "ask", decider: "manager", waitingForHuman: true });

    expect(runtime.attention({ runId: b.id }).gates).toHaveLength(1);
    expect(runtime.attention({ olderThanMinutes: 30 }).gates.map((gate) => gate.runId)).toEqual([a.id]);
    expect(runtime.attention().failed).toEqual([]);

    await runtime.cancelRun(c.id, "x", null);
    expect(runtime.attention().gates).toHaveLength(2);
    expect(runtime.attention({ includeFailed: true }).failed).toEqual([]);
  });

  it("includes failed runs and runs that lost their manager, with reason and restartableFrom", async () => {
    const { runtime, store } = await setup();
    const a = await runtime.startPlaybook(mgr("m1"), "ask", {});
    await store.mutate(a.id, (run) => {
      run.status = "failed";
      run.failure = "manager lost (archived)";
    });
    const { failed } = runtime.attention({ includeFailed: true });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ runId: a.id, failure: "manager lost (archived)", managerLost: true });
    expect(Array.isArray(failed[0]!.restartableFrom)).toBe(true);
  });
});

describe("get_run is read-only on a run of another manager", () => {
  it("reads any run, and every write refuses it", async () => {
    const { runtime } = await setup();
    const a = await runtime.startPlaybook(mgr("m1"), "ask", {});
    expect(runtime.readableRun("other", a.id).id).toBe(a.id);
    expect(() => runtime.readableRun("other", "nope")).toThrow(/unknown run/);
    expect(() => runtime.readableRun("other", undefined)).toThrow(/you have no run/);
    const refused = /belongs to another manager/;
    await expect(runtime.startStep("other", a.id, "work", "")).rejects.toThrow(refused);
    await expect(runtime.completeStep("other", a.id, "work", { outcome: "success" })).rejects.toThrow(refused);
    await expect(runtime.requestGate("other", a.id, "work", "x", "")).rejects.toThrow(refused);
    await expect(runtime.settleJob("other", a.id, "j", { summary: "x", outputs: {} })).rejects.toThrow(refused);
    expect(() => runtime.ownedRun("other", a.id)).toThrow(refused);
  });
});

describe("event log", () => {
  it("records gate and run events with sequence numbers, for an agent that was away", async () => {
    const { runtime } = await setup();
    await runtime.watchEvents();
    const a = await runtime.startPlaybook(mgr("m1"), "human", {});
    const gate = await runtime.requestGate("m1", a.id, "approve", "Ship?", "");
    await runtime.watchEvents();
    await runtime.decideGate(a.id, gate.id, { decision: "approved", comment: "ok", by: "U1", via: "panel", now: now() });
    await runtime.watchEvents();
    const { events, lastSeq } = await runtime.bus.recent();
    expect(events.map((event) => [event.seq, event.type])).toEqual([[1, "gate.opened"], [2, "gate.decided"], [3, "step.completed"], [4, "run.completed"]]);
    expect(events[1]!.payload).toMatchObject({ decision: "approved", decidedVia: "panel", comment: "ok" });
    expect(lastSeq).toBe(4);
    expect((await runtime.bus.recent({ since: 1 })).events.map((event) => event.type)).toEqual(["gate.decided", "step.completed", "run.completed"]);
  });
});

describe("event subscriptions", () => {
  it("tells the subscriber when a gate opens, with the question, choices, decider and holder", async () => {
    const { runtime, sent } = await setup();
    const sub = await runtime.subscribeEvents("watcher", ["gate.opened"], {});
    await runtime.watchEvents(); // seeds
    const human = await runtime.startPlaybook(mgr("m1"), "human", {});
    await runtime.requestGate("m1", human.id, "approve", "Ship A?", "");
    const role = await runtime.startPlaybook(mgr("m2"), "role", {});
    await runtime.requestGate("m2", role.id, "approve", "Ship B?", "");
    await runtime.watchEvents();
    const text = toAgent(sent, "watcher");
    expect(sent.filter((entry) => entry.agentId === "watcher")).toHaveLength(1);
    expect(text).toMatch(/2 events/);
    expect(text).toContain(`run ${human.id}`);
    expect(text).toMatch(/Ship A\?[\s\S]*approved \| rejected \(needs a comment\)[\s\S]*held by human/);
    expect(text).toMatch(/Ship B\?[\s\S]*held by role reviewer, not waiting for a human yet/);
    expect(text).toContain(`list_gates { runId: "${human.id}" }`);
    expect(text).toContain(`get_run { runId: "${human.id}", view: "full" }`);
    await runtime.watchEvents();
    expect(sent.filter((entry) => entry.agentId === "watcher")).toHaveLength(1);
    expect(sub.id).toMatch(/^sub-/);
  });

  it("does not announce what was open when it started, and tells when a gate is decided", async () => {
    const first = await setup();
    const run = await first.runtime.startPlaybook(mgr("m1"), "human", {});
    const gate = await first.runtime.requestGate("m1", run.id, "approve", "Ship?", "");
    await first.runtime.subscribeEvents("watcher", ["gate.opened", "gate.decided"], {});
    await first.runtime.dispose();
    const again = await setup({}, { dir: first.dir, file: "" });
    await again.runtime.watchEvents();
    expect(toAgent(again.sent, "watcher")).toBe("");
    await again.runtime.decideGate(run.id, gate.id, { decision: "rejected", comment: "Not now.", by: "U1", via: "chat", now: now() });
    await again.runtime.watchEvents();
    expect(toAgent(again.sent, "watcher")).toMatch(/gate.decided[\s\S]*rejected, by U1 via chat\. Comment: "Not now\."/);
  });

  it("does not report a decision back to the manager or role that took it", async () => {
    const { runtime, sent } = await setup();
    await runtime.subscribeEvents("m1", ["gate.decided"], {});
    await runtime.subscribeEvents("watcher", ["gate.decided"], {});
    await runtime.watchEvents();
    const run = await runtime.startPlaybook(mgr("m1"), "human", {});
    const gate = await runtime.requestGate("m1", run.id, "approve", "Ship?", "");
    await runtime.watchEvents();
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: "U1", via: "chat", now: now() });
    await runtime.watchEvents();
    expect(toAgent(sent, "m1")).toBe("");
    expect(toAgent(sent, "watcher")).toMatch(/gate.decided/);
  });

  it("sends one reminder per gate after olderThanMinutes (default 30)", async () => {
    const { runtime, store, sent } = await setup();
    await runtime.subscribeEvents("watcher", ["gate.stale"], {});
    await runtime.subscribeEvents("quick", ["gate.stale"], { olderThanMinutes: 5 });
    const run = await runtime.startPlaybook(mgr("m1"), "human", {});
    await runtime.requestGate("m1", run.id, "approve", "Ship?", "");
    await runtime.watchEvents();
    expect(sent).toHaveLength(0);
    await store.mutate(run.id, (current) => void (current.gates[0]!.requestedAt = new Date(Date.now() - 10 * 60_000).toISOString()));
    await runtime.watchEvents();
    expect(toAgent(sent, "quick")).toMatch(/gate.stale: still open after 10 min/);
    expect(toAgent(sent, "watcher")).toBe("");
    await store.mutate(run.id, (current) => void (current.gates[0]!.requestedAt = new Date(Date.now() - 31 * 60_000).toISOString()));
    await runtime.watchEvents();
    await runtime.watchEvents();
    expect(toAgent(sent, "watcher").match(/gate.stale/g)).toHaveLength(1);
    expect(toAgent(sent, "quick").match(/gate.stale/g)).toHaveLength(1);
  });

  it("reports a failed run with its reason, and a lost manager as its own event", async () => {
    const { runtime, store, sent } = await setup();
    await runtime.subscribeEvents("failures", ["run.failed"], {});
    await runtime.subscribeEvents("lost", ["run.manager_lost"], {});
    await runtime.watchEvents();
    const a = await runtime.startPlaybook(mgr("m1"), "ask", {});
    const b = await runtime.startPlaybook(mgr("m2"), "ask", {});
    await store.mutate(a.id, (run) => void Object.assign(run, { status: "failed", failure: "step work failed" }));
    await store.mutate(b.id, (run) => void Object.assign(run, { status: "failed", failure: "manager lost (archived)" }));
    await runtime.watchEvents();
    expect(toAgent(sent, "failures")).toMatch(new RegExp(`run.failed: run ${a.id}[\\s\\S]*step work failed; restartable from`));
    expect(toAgent(sent, "failures")).not.toContain(b.id);
    expect(toAgent(sent, "lost")).toMatch(new RegExp(`run.manager_lost: run ${b.id}[\\s\\S]*manager lost \\(archived\\)`));
    expect(toAgent(sent, "lost")).not.toContain(a.id);
  });

  it("filters by playbook, run and decider", async () => {
    const { runtime, sent } = await setup();
    await runtime.subscribeEvents("byPlaybook", ["gate.opened"], { playbook: "role" });
    await runtime.subscribeEvents("byDecider", ["gate.opened"], { deciderBy: "human" });
    await runtime.watchEvents();
    const human = await runtime.startPlaybook(mgr("m1"), "human", {});
    await runtime.subscribeEvents("byRun", ["gate.opened"], { runId: human.id });
    await runtime.requestGate("m1", human.id, "approve", "Ship A?", "");
    const role = await runtime.startPlaybook(mgr("m2"), "role", {});
    await runtime.requestGate("m2", role.id, "approve", "Ship B?", "");
    await runtime.watchEvents();
    expect(toAgent(sent, "byPlaybook")).toMatch(/Ship B\?/);
    expect(toAgent(sent, "byPlaybook")).not.toMatch(/Ship A\?/);
    expect(toAgent(sent, "byDecider")).toMatch(/Ship A\?/);
    expect(toAgent(sent, "byDecider")).not.toMatch(/Ship B\?/);
    expect(toAgent(sent, "byRun")).toMatch(/Ship A\?/);
    expect(toAgent(sent, "byRun")).not.toMatch(/Ship B\?/);
    await expect(runtime.subscribeEvents("x", ["gate.opened"], { runId: "nope" })).rejects.toThrow(/unknown run/);
  });

  it("merges a burst into one message once the debounce window has passed", async () => {
    const { runtime, sent } = await setup({ debounceMs: 5000 });
    await runtime.subscribeEvents("watcher", ["gate.opened"], {});
    const t = Date.now();
    await runtime.watchEvents(t);
    const a = await runtime.startPlaybook(mgr("m1"), "human", {});
    await runtime.requestGate("m1", a.id, "approve", "Ship A?", "");
    await runtime.watchEvents(t + 1000);
    const b = await runtime.startPlaybook(mgr("m2"), "human", {});
    await runtime.requestGate("m2", b.id, "approve", "Ship B?", "");
    await runtime.watchEvents(t + 3000);
    expect(sent).toHaveLength(0);
    await runtime.watchEvents(t + 7000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/2 events[\s\S]*Ship A\?[\s\S]*Ship B\?/);
  });

  it("lists and removes subscriptions, only the subscriber's own", async () => {
    const { runtime } = await setup();
    const mine = await runtime.subscribeEvents("me", ["run.failed"], { playbook: "human" });
    await runtime.subscribeEvents("you", ["run.failed"], {});
    expect((await runtime.bus.list("me")).map((sub) => sub.id)).toEqual([mine.id]);
    await expect(runtime.unsubscribeEvents("you", mine.id)).rejects.toThrow(/no subscription/);
    await runtime.unsubscribeEvents("me", mine.id);
    expect(await runtime.bus.list("me")).toEqual([]);
    expect(await runtime.bus.list("you")).toHaveLength(1);
  });

  it("keeps subscriptions across a restart, and drops them when the agent is archived", async () => {
    const first = await setup();
    const sub = await first.runtime.subscribeEvents("watcher", ["gate.opened"], { playbook: "human" });
    await first.runtime.subscribeEvents("gone", ["gate.opened"], {});
    await first.runtime.dispose();
    const file = path.join(first.dir, "data", "subscriptions.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2);

    const again = await setup({}, { dir: first.dir, file });
    expect((await again.runtime.bus.list("watcher")).map((entry) => entry.id)).toEqual([sub.id]);
    await again.runtime.onAgentArchived("watcher");
    expect(await again.runtime.bus.list("watcher")).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);

    // An agent that vanished without the hook (lost) is dropped at the next send.
    await again.runtime.watchEvents();
    again.archived.add("gone");
    const run = await again.runtime.startPlaybook(mgr("m1"), "human", {});
    await again.runtime.requestGate("m1", run.id, "approve", "Ship?", "");
    await again.runtime.watchEvents();
    expect(await again.runtime.bus.list("gone")).toEqual([]);
    expect(toAgent(again.sent, "gone")).toBe("");
  });
});

describe("gate.escalated", () => {
  async function roleGate(options: { fail?: boolean } = {}) {
    const ctx = await setup();
    await ctx.runtime.subscribeEvents("watcher", ["gate.*"], {});
    await ctx.runtime.watchEvents();
    faults.failCreate = options.fail ?? false;
    const run = await ctx.runtime.startPlaybook(mgr("m1"), "role", {});
    const gate = await ctx.runtime.requestGate("m1", run.id, "approve", "Ship?", "");
    await ctx.runtime.watchEvents();
    return { ...ctx, run, gate };
  }
  const escalations = async (runtime: Runtime) => (await runtime.bus.recent({ types: ["gate.escalated"] })).events;

  it("is emitted when a role escalates, with the reason, who held it and the tools; never back to the role", async () => {
    const { runtime, store, sent, run, gate } = await roleGate();
    const decider = gate.deciderAgentId!;
    await runtime.subscribeEvents(decider, ["gate.escalated"], {});
    await runtime.onTurnEnded("watcher", "completed"); // the watcher's turn on the gate.opened message ends
    await runtime.reportGateDecision(decider, { decision: "escalate", comment: "It touches billing." });
    await runtime.watchEvents();
    const [event] = await escalations(runtime);
    expect(event!.payload).toMatchObject({
      runId: run.id, playbook: "role", gateId: gate.id, stepId: "approve", kind: "gate", question: "Ship?",
      heldBefore: "role", heldBeforeRole: "reviewer", deciderBy: "role", reason: "It touches billing.", waitingForHuman: true, roleDeciding: false,
    });
    expect(event!.payload.choices).toHaveLength(2);
    expect(event!.payload.workspaceDir).toBeTruthy();
    expect(event!.payload.projectId).toBeTruthy();
    expect(toAgent(sent, "watcher")).toMatch(/gate.escalated: role reviewer left the gate at step approve[\s\S]*It touches billing\.[\s\S]*approved \| rejected[\s\S]*Now waiting for a human[\s\S]*list_gates[\s\S]*get_run/);
    expect(toAgent(sent, decider)).not.toMatch(/gate.escalated/);
    await runtime.watchEvents();
    expect(await escalations(runtime)).toHaveLength(1);
    const listed = listAttention(store.list(), Date.now(), { runId: run.id }).gates[0]!;
    expect(listed).toMatchObject({ waitingForHuman: true, escalationReason: "It touches billing.", heldBy: "human" });
    expect(listed.escalatedAt).toBeTruthy();
  });

  it("is emitted when the role ends without a decision, after the reminder", async () => {
    const { runtime, gate } = await roleGate();
    await runtime.onTurnEnded(gate.deciderAgentId!, "completed");
    await runtime.watchEvents();
    expect(await escalations(runtime)).toHaveLength(0);
    await runtime.onTurnEnded(gate.deciderAgentId!, "completed");
    await runtime.watchEvents();
    expect((await escalations(runtime))[0]!.payload).toMatchObject({ reason: "its agent ended without a decision", heldBefore: "role" });
  });

  it("is emitted when the role's agent fails to start", async () => {
    const { runtime } = await roleGate({ fail: true });
    const [event] = await escalations(runtime);
    expect(event!.payload).toMatchObject({ heldBefore: "role", reason: expect.stringContaining("its agent could not start: no capacity"), waitingForHuman: true });
  });

  it("is emitted when the role's agent was archived or lost in a restart", async () => {
    const first = await roleGate();
    const decider = first.gate.deciderAgentId!;
    await first.runtime.dispose();
    faults.gone.add(decider);
    const again = await setup({}, { dir: first.dir, file: "" });
    await again.runtime.subscribeEvents("late", ["gate.escalated"], {});
    await again.runtime.watchEvents();
    await again.runtime.watchEvents();
    expect((await escalations(again.runtime)).map((event) => event.payload.reason)).toEqual(["its agent was lost in a daemon restart"]);
    expect(toAgent(again.sent, "late")).toMatch(/lost in a daemon restart/);
  });

  it("is emitted when the manager escalates, and only on a manager's gate", async () => {
    const { runtime, sent } = await setup();
    await runtime.subscribeEvents("watcher", ["gate.escalated"], { deciderBy: "manager" });
    await runtime.subscribeEvents("m1", ["gate.escalated"], {});
    await runtime.watchEvents();
    const run = await runtime.startPlaybook(mgr("m1"), "manager", {});
    const gate = await runtime.requestGate("m1", run.id, "approve", "Ship?", "");
    await runtime.watchEvents();
    expect(await escalations(runtime)).toHaveLength(0);
    const human = await runtime.startPlaybook(mgr("m2"), "human", {});
    await runtime.requestGate("m2", human.id, "approve", "Ship?", "");
    await expect(runtime.escalateByManager("m2", human.id, "approve", "x")).rejects.toThrow(/decided by a human/);
    await expect(runtime.escalateByManager("m3", run.id, "approve", "x")).rejects.toThrow(/belongs to another manager/);
    expect(await runtime.escalateByManager("m1", run.id, "approve", "Touches billing.")).toMatch(/left to a human/);
    await runtime.watchEvents();
    expect((await escalations(runtime)).map((event) => event.payload)).toHaveLength(1);
    expect((await escalations(runtime))[0]!.payload).toMatchObject({ runId: run.id, gateId: gate.id, heldBefore: "manager", heldBeforeRole: null, reason: "Touches billing.", waitingForHuman: true });
    expect(toAgent(sent, "watcher")).toMatch(/the manager left the gate/);
    expect(toAgent(sent, "m1")).not.toMatch(/gate.escalated/);
    expect(await runtime.escalateByManager("m1", run.id, "approve", "again")).toMatch(/already left/);
  });

  it("does not fire for a gate that opens waiting for a human, and filters like other gate events", async () => {
    const { runtime, sent } = await setup();
    await runtime.subscribeEvents("w-role", ["gate.escalated"], { deciderBy: "role" });
    await runtime.subscribeEvents("w-manager", ["gate.escalated"], { deciderBy: "manager" });
    await runtime.watchEvents();
    const human = await runtime.startPlaybook(mgr("m1"), "human", {});
    await runtime.requestGate("m1", human.id, "approve", "Ship?", "");
    const role = await runtime.startPlaybook(mgr("m2"), "role", {});
    const gate = await runtime.requestGate("m2", role.id, "approve", "Ship?", "");
    await runtime.reportGateDecision(gate.deciderAgentId!, { decision: "escalate", comment: "unsure" });
    await runtime.watchEvents();
    expect((await escalations(runtime)).map((event) => event.runId)).toEqual([role.id]);
    expect(toAgent(sent, "w-role")).toMatch(/gate.escalated/);
    expect(toAgent(sent, "w-manager")).toBe("");
    // A human gate showed up as opened, already waiting for a human.
    const opened = (await runtime.bus.recent({ types: ["gate.opened"] })).events.find((event) => event.runId === human.id)!;
    expect(opened.payload).toMatchObject({ heldBy: "human", roleDeciding: false });
  });

  it("can be caught up with list_events", async () => {
    const { runtime, gate } = await roleGate();
    const before = (await runtime.bus.recent()).lastSeq;
    await runtime.reportGateDecision(gate.deciderAgentId!, { decision: "escalate", comment: "unsure" });
    await runtime.watchEvents();
    const missed = await runtime.bus.recent({ since: before, types: ["gate.*"] });
    expect(missed.events.map((event) => event.type)).toEqual(["gate.escalated"]);
  });

  it("is not emitted again for a gate escalated before a restart", async () => {
    const first = await roleGate();
    await first.runtime.reportGateDecision(first.gate.deciderAgentId!, { decision: "escalate", comment: "unsure" });
    await first.runtime.watchEvents();
    await first.runtime.dispose();
    const again = await setup({}, { dir: first.dir, file: "" });
    await again.runtime.watchEvents();
    expect(await escalations(again.runtime)).toHaveLength(1);
  });
});

describe("delivery: idle", () => {
  async function opened(ctx: Awaited<ReturnType<typeof setup>>, manager: string) {
    await ctx.runtime.watchEvents(); // seeds
    const run = await ctx.runtime.startPlaybook(mgr(manager), "human", {});
    await ctx.runtime.requestGate(manager, run.id, "approve", "Ship it?", "");
    await ctx.runtime.watchEvents();
    return run;
  }

  it("sends at once to an idle subscriber, and idle is the default", async () => {
    const ctx = await setup();
    const sub = await ctx.runtime.subscribeEvents("watcher", ["gate.opened"], {});
    expect(sub.delivery).toBe("idle");
    await opened(ctx, "m1");
    expect(toAgent(ctx.sent, "watcher")).toContain("Ship it?");
  });

  it("holds events while the subscriber is in a turn and sends one merged message, in order, when it ends", async () => {
    const ctx = await setup();
    await ctx.runtime.subscribeEvents("watcher", ["gate.*"], {});
    ctx.runtime.onTurnStarted("watcher");
    const run = await opened(ctx, "m1");
    const gate = ctx.store.get(run.id)!.gates[0]!;
    await ctx.runtime.decideGate(run.id, gate.id, { decision: "approved", comment: "ok", by: "U1", via: "panel", now: now() });
    await ctx.runtime.watchEvents();
    await ctx.runtime.watchEvents();
    expect(toAgent(ctx.sent, "watcher")).toBe("");

    await ctx.runtime.onTurnEnded("watcher", "completed");
    const messages = ctx.sent.filter((entry) => entry.agentId === "watcher");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("2 events");
    expect(messages[0]!.text.indexOf("gate.opened")).toBeGreaterThanOrEqual(0);
    expect(messages[0]!.text.indexOf("Ship it?")).toBeLessThan(messages[0]!.text.indexOf("approved"));
  });

  it("holds while a subscriber we have not seen (after a restart) reports running, then sends once idle", async () => {
    const ctx = await setup();
    await ctx.runtime.subscribeEvents("watcher", ["gate.opened"], {});
    faults.running.add("watcher");
    await opened(ctx, "m1");
    expect(toAgent(ctx.sent, "watcher")).toBe("");
    faults.running.delete("watcher");
    await ctx.runtime.onTurnEnded("watcher", "completed");
    expect(toAgent(ctx.sent, "watcher")).toContain("Ship it?");
  });

  it("steer keeps sending into a running turn", async () => {
    const ctx = await setup();
    const sub = await ctx.runtime.subscribeEvents("watcher", ["gate.opened"], {}, "steer");
    expect(sub.delivery).toBe("steer");
    ctx.runtime.onTurnStarted("watcher");
    await opened(ctx, "m1");
    expect(toAgent(ctx.sent, "watcher")).toContain("Ship it?");
  });

  it("drops a held subscription when the subscriber is archived meanwhile", async () => {
    const ctx = await setup();
    await ctx.runtime.subscribeEvents("watcher", ["gate.opened"], {});
    ctx.runtime.onTurnStarted("watcher");
    await opened(ctx, "m1");
    ctx.archived.add("watcher");
    await ctx.runtime.onTurnEnded("watcher", "completed");
    expect(toAgent(ctx.sent, "watcher")).toBe("");
    expect(await ctx.runtime.bus.list("watcher")).toEqual([]);
  });

  it("keeps held events across a restart and caps a long wait", async () => {
    const first = await setup();
    await first.runtime.subscribeEvents("watcher", ["gate.opened"], {});
    await first.runtime.watchEvents(); // seeds
    first.runtime.onTurnStarted("watcher");
    for (let i = 0; i < 53; i++) {
      const run = await first.runtime.startPlaybook(mgr(`m${i}`), "human", {});
      await first.runtime.requestGate(`m${i}`, run.id, "approve", `Ship ${i}?`, "");
    }
    await first.runtime.watchEvents();
    await first.runtime.dispose();

    const again = await setup({}, { dir: first.dir, file: "" });
    await again.runtime.onTurnEnded("watcher", "completed");
    const text = toAgent(again.sent, "watcher");
    expect(text).toContain("50 events");
    expect(text).toContain("3 earlier events were dropped");
  });
});

describe("step and run events", () => {
  const base = (run: { id: string }) => ({ runId: run.id, playbook: "flow", runName: null, projectId: "p" });

  it("emits step.started, step.completed (failure and retry included) and run.completed once each, in order", async () => {
    const { runtime, sent } = await setup();
    await runtime.subscribeEvents("watcher", ["step.*", "run.*"], {}, "steer");
    await runtime.subscribeEvents("byPlaybook", ["step.completed"], { playbook: "flow", stepId: "work" }, "steer");
    await runtime.subscribeEvents("other", ["step.started"], { playbook: "human" });
    await runtime.watchEvents();
    const run = await runtime.startPlaybook(mgr("m1"), "flow", {});
    await runtime.startStep("m1", run.id, "work", "");
    await runtime.watchEvents();
    await runtime.completeStep("m1", run.id, "work", { outcome: "failure", summary: "nope" });
    await runtime.watchEvents();
    await runtime.startStep("m1", run.id, "work", "");
    await runtime.completeStep("m1", run.id, "work", { outcome: "success", summary: "ok" });
    await runtime.startStep("m1", run.id, "wrap", "");
    await runtime.completeStep("m1", run.id, "wrap", { outcome: "success", summary: "ok" });
    await runtime.watchEvents();
    await runtime.watchEvents();
    const { events } = await runtime.bus.recent();
    expect(events.map((event) => [event.type, event.payload.stepId ?? null, event.payload.attempt ?? null, event.payload.outcome ?? null])).toEqual([
      ["step.started", "work", 1, null],
      ["step.completed", "work", 1, "failure"],
      ["step.started", "work", 2, null],
      ["step.completed", "work", 2, "success"],
      ["step.started", "wrap", 1, null],
      ["step.completed", "wrap", 1, "success"],
      ["run.completed", null, null, null],
    ]);
    expect(events[1]!.payload).toMatchObject({ ...base(run), workspaceDir: expect.any(String) });
    expect(toAgent(sent, "watcher")).toMatch(/step.completed: step work \(attempt 1\) of run [\s\S]*ended with outcome failure/);
    expect(toAgent(sent, "byPlaybook").match(/step.completed/g)).toHaveLength(2);
    expect(toAgent(sent, "byPlaybook")).not.toMatch(/step.started|wrap/);
    expect(toAgent(sent, "other")).toBe("");
    expect((await runtime.bus.recent({ types: ["run.completed"] })).events).toHaveLength(1);
  });

  it("emits run.canceled with its reason", async () => {
    const { runtime } = await setup();
    await runtime.watchEvents();
    const run = await runtime.startPlaybook(mgr("m1"), "flow", {});
    await runtime.cancelRun(run.id, "changed my mind", "U1");
    await runtime.watchEvents();
    const { events } = await runtime.bus.recent({ types: ["run.canceled"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ...base(run), reason: "changed my mind" });
  });

  it("does not announce past transitions again after a daemon restart", async () => {
    const first = await setup();
    await first.runtime.watchEvents();
    const run = await first.runtime.startPlaybook(mgr("m1"), "flow", {});
    await first.runtime.startStep("m1", run.id, "work", "");
    await first.runtime.completeStep("m1", run.id, "work", { outcome: "success", summary: "ok" });
    await first.runtime.watchEvents();
    const before = (await first.runtime.bus.recent()).events.length;
    await first.runtime.dispose();
    const again = await setup({}, { dir: first.dir, file: "" });
    await again.runtime.watchEvents();
    await again.runtime.watchEvents();
    expect((await again.runtime.bus.recent()).events).toHaveLength(before);
    await again.runtime.startStep("m1", run.id, "wrap", "");
    await again.runtime.watchEvents();
    expect((await again.runtime.bus.recent({ since: before })).events.map((event) => event.type)).toEqual(["step.started"]);
  });

  it("emits step.slow once when a running step passes factor x its usual duration, never for a restart or without a baseline", async () => {
    const { runtime, store } = await setup();
    await runtime.subscribeEvents("watcher", ["step.slow"], { playbook: "flow" }, "steer");
    await runtime.watchEvents();
    const t0 = Date.now() - 3_600_000;
    for (let i = 0; i < 3; i++) {
      const done = await runtime.startPlaybook(mgr(`h${i}`), "flow", {});
      await runtime.startStep(`h${i}`, done.id, "work", "");
      await runtime.completeStep(`h${i}`, done.id, "work", { outcome: "success", summary: "ok" });
      await store.mutate(done.id, (run) => {
        const attempt = run.steps.work!.attempts[0]!;
        attempt.startedAt = new Date(t0 + i * 600_000).toISOString();
        attempt.endedAt = new Date(t0 + i * 600_000 + 240_000).toISOString();
      });
    }
    const run = await runtime.startPlaybook(mgr("m1"), "flow", {});
    await runtime.startStep("m1", run.id, "work", "");
    await store.mutate(run.id, (r) => void (r.steps.work!.attempts[0]!.startedAt = new Date(Date.now() - 6 * 60_000).toISOString()));
    await runtime.watchEvents(Date.now());
    expect((await runtime.bus.recent({ types: ["step.slow"] })).events).toHaveLength(0);
    await store.mutate(run.id, (r) => void (r.steps.work!.attempts[0]!.startedAt = new Date(Date.now() - 12 * 60_000).toISOString()));
    await runtime.watchEvents(Date.now() + 60_000);
    await runtime.watchEvents(Date.now() + 120_000);
    const { events } = await runtime.bus.recent({ types: ["step.slow"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ runId: run.id, stepId: "work", baselineMs: 240_000, factor: 2, samples: 3 });
  });

  it("accepts the new types and fields in subscriptions and refuses unknown filter keys", async () => {
    const { runtime } = await setup();
    await runtime.subscribeEvents("a", ["step.started", "step.completed", "run.completed", "run.canceled"], { runId: (await runtime.startPlaybook(mgr("m1"), "flow", {})).id });
    await runtime.subscribeEvents("a", ["step.completed"], { outcome: "failure", stepId: "work" });
    await expect(runtime.subscribeEvents("a", ["run.completed"], { outcome: "x" })).rejects.toThrow(/not a field/);
  });
});
