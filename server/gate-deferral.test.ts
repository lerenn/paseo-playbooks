import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deferRequest, parseWhen } from "../shared/defer";
import { describeCondition, isWaiting, needsReview, waitsForHuman } from "../shared/gates";
import { gatesOnBehalfSetting, loadPlaybooks } from "./loader";
import { gateListing } from "./overseer";
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

describe("gate deferral", () => {
  const coordinator = { id: "coord", title: "Coordinator", parentAgentId: null };
  const hour = 3_600_000;
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
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
  const gateOf = (store: RunStore, runId: string) => store.get(runId)!.gates[0]!;
  const returned = async (runtime: Runtime) => (await runtime.bus.recent({ types: ["gate.returned"] })).events;

  it("defers an open gate with a reason and a condition: it stays open and decidable, but is not to be reviewed", async () => {
    const { runtime, store, run, gate } = await open();
    await runtime.deferGateOnBehalf(coordinator, { runId: run.id, gateId: gate.id, reason: "Waiting for the legal review", condition: { kind: "manual", note: "legal reply" } });
    const stored = gateOf(store, run.id);
    expect(stored.status).toBe("pending");
    expect(stored.deferral).toMatchObject({ reason: "Waiting for the legal review", condition: { kind: "manual", note: "legal reply" }, returnedAt: null, deferredBy: "agent Coordinator on behalf of the human" });
    expect(waitsForHuman(stored)).toBe(true);
    expect(needsReview(stored)).toBe(false);
    expect(isWaiting(stored)).toBe(true);
    expect(gateListing(store.get(run.id)!, stored, Date.now())).toMatchObject({ needsReview: false, deferred: true, waitingForHuman: true });
    expect(store.get(run.id)!.history.some((entry) => entry.type === "gate_deferred")).toBe(true);
    // Decision rules are unchanged: the same choice, the same path.
    const decided = await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: "human", via: "panel", now: now() });
    expect(decided.gate.status).toBe("approved");
  });

  it("requires a reason, a future date and a tracked run of the same project, and refuses self-references", async () => {
    const { runtime, run, gate } = await open();
    const defer = (extra: object) => runtime.deferGate(run.id, gate.id, { reason: "later", condition: { kind: "manual", note: "" }, ...extra }, "human");
    await expect(defer({ reason: "  " })).rejects.toThrow(/reason is required/);
    await expect(defer({ condition: { kind: "date", at: "yesterday" } })).rejects.toThrow(/not a date/);
    await expect(defer({ condition: { kind: "date", at: later(-hour) } })).rejects.toThrow(/not in the future/);
    await expect(defer({ remindAt: later(-hour) })).rejects.toThrow(/not in the future/);
    await expect(defer({ condition: { kind: "run_ended", runId: run.id } })).rejects.toThrow(/own run/);
    await expect(defer({ condition: { kind: "run_ended", runId: "nope" } })).rejects.toThrow(/not a run of this project/);
    await expect(defer({ condition: { kind: "gate_decided", runId: run.id, gateId: gate.id } })).rejects.toThrow(/its own decision/);
  });

  it("is refused for the run's own agents, another project's Sidekick, and with on_behalf: deny", async () => {
    const { runtime, store, run, gate } = await open();
    const input = { runId: run.id, gateId: gate.id, reason: "later", condition: { kind: "manual" as const, note: "" } };
    await expect(runtime.deferGateOnBehalf({ id: "m", title: null, parentAgentId: null }, input)).rejects.toThrow(/outside the runs/);
    await expect(runtime.deferGateOnBehalf({ id: "other-sk", title: null, parentAgentId: null }, input)).rejects.toThrow(/not a run of this Sidekick's project/);
    expect(gateOf(store, run.id).deferral ?? null).toBeNull();
    const denied = await open("gates: { on_behalf: deny }\n");
    await expect(denied.runtime.deferGateOnBehalf(coordinator, { ...input, runId: denied.run.id, gateId: denied.gate.id })).rejects.toThrow(/turned off/);
  });

  it("refuses a gate that is already decided", async () => {
    const { runtime, run, gate } = await open();
    await runtime.decideGate(run.id, gate.id, { decision: "approved", comment: null, by: "human", via: "panel", now: now() });
    await expect(runtime.deferGate(run.id, gate.id, { reason: "x", condition: { kind: "manual", note: "" } }, "human")).rejects.toThrow(/not open/);
  });

  it("brings a gate back by hand and says so on the bus; bringing back twice changes nothing", async () => {
    const { runtime, store, run, gate } = await open();
    await runtime.deferGate(run.id, gate.id, { reason: "later", condition: { kind: "manual", note: "PR merge" } }, "Louis");
    expect(await runtime.returnGate(run.id, gate.id, "Louis", "merged", "human")).toBe(true);
    expect(needsReview(gateOf(store, run.id))).toBe(true);
    expect(gateOf(store, run.id).deferral).toMatchObject({ returnedBy: "human" });
    expect(await runtime.returnGate(run.id, gate.id, "Louis", null, "human")).toBe(false);
    const events = await returned(runtime);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ returnedBy: "human", automatic: false, reason: "later" });
  });

  it("returns a gate on its tracked date, and announces it once", async () => {
    const { runtime, store, run, gate } = await open();
    await runtime.deferGate(run.id, gate.id, { reason: "after the freeze", condition: { kind: "date", at: later(hour) } }, "Louis");
    await runtime.watchEvents(Date.now() + hour / 2);
    expect(needsReview(gateOf(store, run.id))).toBe(false);
    await runtime.watchEvents(Date.now() + 2 * hour);
    await runtime.watchEvents(Date.now() + 3 * hour);
    expect(needsReview(gateOf(store, run.id))).toBe(true);
    expect(gateOf(store, run.id).deferral).toMatchObject({ returnedBy: "date" });
    const events = await returned(runtime);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ returnedBy: "date", automatic: true });
  });

  it("never returns a manual condition by itself, but its reminder date does", async () => {
    const { runtime, store, run, gate } = await open();
    await runtime.deferGate(run.id, gate.id, { reason: "waiting for the PR", condition: { kind: "manual", note: "PR merge" }, remindAt: later(hour) }, "Louis");
    await runtime.watchEvents(Date.now() + hour / 2);
    expect(isWaiting(gateOf(store, run.id))).toBe(true);
    await runtime.watchEvents(Date.now() + 2 * hour);
    expect(needsReview(gateOf(store, run.id))).toBe(true);
    expect(gateOf(store, run.id).deferral).toMatchObject({ returnedBy: "reminder" });
    expect(describeCondition({ ...gateOf(store, run.id).deferral!, returnedAt: null })).toMatch(/Manual: nothing tracks this/);
  });

  it("returns a gate when the run it waits for ends, or the gate it waits for is decided", async () => {
    const { runtime, store, run, gate } = await open();
    const other = await runtime.startPlaybook({ id: "m2", workspaceId: "ws2", cwd: "/" }, "main", {});
    const otherGate = await runtime.requestGate("m2", other.id, "approve", "Ship the other?", "");
    await runtime.deferGate(run.id, gate.id, { reason: "needs the other run first", condition: { kind: "gate_decided", runId: other.id, gateId: otherGate.id } }, "Louis");
    await runtime.watchEvents();
    expect(isWaiting(gateOf(store, run.id))).toBe(true);
    await runtime.decideGate(other.id, otherGate.id, { decision: "approved", comment: null, by: "human", via: "panel", now: now() });
    await runtime.watchEvents();
    expect(gateOf(store, run.id).deferral).toMatchObject({ returnedBy: "gate_decided" });
    expect(needsReview(gateOf(store, run.id))).toBe(true);

    const third = await runtime.startPlaybook({ id: "m3", workspaceId: "ws3", cwd: "/" }, "main", {});
    await runtime.requestGate("m3", third.id, "approve", "Third?", "");
    await runtime.returnGate(run.id, gate.id, "Louis", null, "human").catch(() => false);
    await runtime.deferGate(run.id, gate.id, { reason: "needs the third run to end", condition: { kind: "run_ended", runId: third.id } }, "Louis");
    await runtime.watchEvents();
    expect(isWaiting(gateOf(store, run.id))).toBe(true);
    await runtime.cancelRun(third.id, "test", "from the test");
    await runtime.watchEvents();
    expect(gateOf(store, run.id).deferral).toMatchObject({ returnedBy: "run_ended" });
    expect((await returned(runtime)).length).toBe(2);
  });

  it("a deferred gate leaves the Needs you counts but not the open-gate listing", async () => {
    const { runtime, store, run, gate } = await open();
    await runtime.deferGate(run.id, gate.id, { reason: "later", condition: { kind: "manual", note: "" } }, "Louis");
    const gates = store.get(run.id)!.gates;
    expect(gates.filter(needsReview)).toHaveLength(0);
    expect(gates.filter(waitsForHuman)).toHaveLength(1);
  });
});

describe("defer form requests", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  it("reads dates and refuses what is missing or past", () => {
    expect(parseWhen("")).toBeNull();
    expect(parseWhen("soon")).toBeNull();
    expect(parseWhen("2026-02-31")).toBeNull();
    expect(parseWhen("2026-12-01T09:00:00Z")).toBe("2026-12-01T09:00:00.000Z");
    expect(parseWhen("2026-12-01 14:30")).toBe(new Date(2026, 11, 1, 14, 30).toISOString());
    expect(deferRequest("", { kind: "manual", note: "", remind: "" }, now)).toMatchObject({ ok: false });
    expect(deferRequest("why", { kind: "date", when: "2026-11-01", remind: "" }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/past/) });
    expect(deferRequest("why", { kind: "run_ended", runId: "", remind: "" }, now)).toMatchObject({ ok: false });
    expect(deferRequest("why", { kind: "manual", note: " PR ", remind: "2026-12-01" }, now)).toMatchObject({ ok: true, condition: { kind: "manual", note: "PR" } });
    expect(deferRequest("why", { kind: "gate_decided", runId: "r", gateId: "g", remind: "" }, now)).toMatchObject({ ok: true, condition: { kind: "gate_decided", runId: "r", gateId: "g" } });
  });
});
