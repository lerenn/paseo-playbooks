import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function fakePaseo(dir: string) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived = new Set<string>();
  let agents = 0;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: archived.has(agentId) ? "now" : null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
    archive: async () => void archived.add(agentId),
  });
  const create = async () => {
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
  const runtime = new Runtime(store, { debounceMs: options.debounceMs ?? 0, pollMs: 3_600_000 });
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
    expect(events.map((event) => [event.seq, event.type])).toEqual([[1, "gate.opened"], [2, "gate.decided"]]);
    expect(events[1]!.payload).toMatchObject({ decision: "approved", decidedVia: "panel", comment: "ok" });
    expect(lastSeq).toBe(2);
    expect((await runtime.bus.recent({ since: 1 })).events.map((event) => event.type)).toEqual(["gate.decided"]);
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
