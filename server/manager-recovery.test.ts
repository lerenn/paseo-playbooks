import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GateSchema } from "../shared/types";
import { completeStep, endTurn, newRun, recordReport, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: { error?: boolean; noFallback?: boolean; providerFallback?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "manager-recovery-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.resolve(__dirname, "../examples/.paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "defaults/main.yaml"), `tiers:
  modest:
    - { provider: claude, model: claude-haiku-5-5 }
${options.noFallback || options.providerFallback ? "" : "    - { provider: codex, model: gpt-5-mini, thinking: low }\n"}manager: { tier: modest }
${options.providerFallback ? "providers: { fallback: [codex/gpt-5-mini] }" : ""}
`);
  await writeFile(path.join(root, "release.yaml"), `title: Release
steps:
  - id: prior
    role: { name: implementer }
    outputs: { artifact: {} }
  - id: release
    needs: [prior]
    role: { name: implementer }
    outputs: { pr: {} }
  - id: later
    needs: [release]
    role: { name: implementer }
`);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "release")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const run = newRun({ id: "run_x", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
  const now = new Date().toISOString();
  startAttempt(run, "prior", { agentId: "prior-1", brief: "Already finished", now, readonlySnapshot: null });
  recordReport(run, "prior-1", { outcome: "success", summary: "Verified upstream work", outputs: { artifact: "saved-output" } }, now);
  endTurn(run, "prior-1", { turnEnd: "completed", now, lastMessage: "Done" });
  completeStep(run, "prior", { outcome: "success", now });
  startAttempt(run, "release", { agentId: "step-1", brief: "Ship it", now: new Date().toISOString(), readonlySnapshot: null });
  await store.create(run);
  const manager = { status: "idle", activeTurn: null as unknown, pendingPermissions: [] as unknown[], provider: "claude", model: "claude-haiku-5-5", archivedAt: null };
  let entries: Array<{ item: Record<string, unknown> }> = [{ item: options.error ? { type: "error", message: "quota exceeded" } : { type: "assistant_message", text: "You've hit your weekly limit" } }];
  const created: Array<{ config: { provider?: string; thinkingOptionId?: string } }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  const archived: string[] = [];
  const controls = { failSend: false, createWait: null as Promise<void> | null, sendWait: null as Promise<void> | null, createStarted: null as (() => void) | null };
  const ref = (id: string) => ({
    refresh: async () => ({ agent: { id, ...manager, ...(id === "step-1" ? { status: "running" } : {}) } }),
    timeline: { refetch: async () => ({ entries }) },
    reload: async () => undefined,
    archive: async () => void archived.push(id),
    send: async (text: string) => {
      if (controls.sendWait) await controls.sendWait;
      if (controls.failSend) throw new Error("send failed");
      sent.push({ id, text });
    },
  });
  const api = { agents: { ref, list: async () => ({ entries: [] }) }, workspaces: { ref: () => ({ agents: { create: async (input: (typeof created)[number]) => {
    controls.createStarted?.();
    if (controls.createWait) await controls.createWait;
    created.push(input);
    return { id: `replacement-${created.length}` };
  } } }) } };
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(api as never);
  await store.mutate("run_x", (run) => { run.inbox.push("A pending report notice"); });
  sent.length = 0;
  const recover = (target?: string) => runtime.recoverManager("run_x", "m", "quota recovery", target);
  return { dir, store, runtime, recover, manager, controls, created, sent, archived, setEntries: (value: typeof entries) => { entries = value; } };
}

describe("state-preserving manager recovery", () => {
  it("keeps all run state except manager metadata and delivers the takeover with pending inbox", async () => {
    const f = await setup();
    await f.runtime.report("step-1", { outcome: "failure", summary: "CI red", outputs: {} });
    const before = structuredClone(f.store.get("run_x")!);
    const result = await f.recover();
    expect(result).toMatchObject({ changed: true, from: "m", to: "replacement-1", target: "codex/gpt-5-mini", thinking: "low" });
    const after = f.store.get("run_x")!;
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      if (["managerAgentId", "managerRecoveries", "managerQuotaBlockedId", "managerRecoveryPrompt", "exhausted", "history", "inbox", "updatedAt", "seq"].includes(key)) continue;
      expect(after[key], key).toEqual(before[key]);
    }
    expect(f.created).toHaveLength(1);
    expect(f.created[0]!.config).toMatchObject({ provider: "codex/gpt-5-mini", thinkingOptionId: "low" });
    expect(f.archived).toEqual([]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ id: "replacement-1" });
    expect(f.sent[0]!.text).toContain("A pending report notice");
    expect(f.sent[0]!.text).toContain("Read get_run with view full before acting");
    expect(after.inbox).toEqual([]);
    expect(after.managerRecoveryPrompt).toBeNull();
  });

  for (const by of ["human", "manager", "role"] as const) {
    it(`preserves the open ${by} gate and its decider exactly`, async () => {
      const f = await setup();
      await f.store.mutate("run_x", (run) => {
        run.status = "waiting_gate";
        run.gates.push(GateSchema.parse({ id: "g", kind: "gate", stepId: "release", gotoTarget: null, status: "pending", message: "Review", requestedAt: new Date().toISOString(), decider: by === "role" ? { by, role: "reviewer" } : { by }, deciderAgentId: by === "role" ? "review-agent" : null, comment: null, decidedBy: null, decidedVia: null, decidedAt: null, escalated: null }));
      });
      const before = structuredClone(f.store.get("run_x")!);
      await f.recover();
      expect(f.store.get("run_x")!.gates).toEqual(before.gates);
      expect(f.store.get("run_x")!.steps).toEqual(before.steps);
      expect(f.store.get("run_x")!.status).toBe("waiting_gate");
    });
  }

  it("serializes simultaneous recoveries and persists idempotency through a reload", async () => {
    const f = await setup();
    const results = await Promise.all([f.recover(), f.recover(), f.recover()]);
    expect(results.map((r) => r.changed)).toEqual([true, false, false]);
    expect(f.created).toHaveLength(1);
    const reloaded = new RunStore(path.join(f.dir, "runs"));
    await reloaded.init();
    const runtime = new Runtime(reloaded, { autoStartAgents: false });
    runtimes.push(runtime);
    // A completed CAS retry needs no provider access or new agent.
    expect(await runtime.recoverManager("run_x", "m", "retry")).toMatchObject({ changed: false, to: "replacement-1" });
  });

  it("refuses mismatched manager IDs before creating or sending anything", async () => {
    const f = await setup();
    await expect(f.runtime.recoverManager("run_x", "wrong", "quota")).rejects.toThrow(/manager changed/);
    expect(f.created).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it("does not replay steps and suppresses delivery to the old manager during a recovery race", async () => {
    const f = await setup();
    let release!: () => void;
    f.controls.createWait = new Promise<void>((resolve) => { release = resolve; });
    const before = structuredClone(f.store.get("run_x")!.steps);
    const recovery = f.recover();
    const delivery = f.runtime.deliver("run_x");
    release();
    await Promise.all([recovery, delivery]);
    await f.runtime.onManagerTurnEnded("m");
    expect(f.sent.every((s) => s.id === "replacement-1")).toBe(true);
    expect(f.store.get("run_x")!.steps).toEqual(before);
    expect(f.created).toHaveLength(1);
  });

  it("retains inbox and takeover on send failure and retries without another replacement", async () => {
    const f = await setup();
    f.controls.failSend = true;
    await f.recover();
    expect(f.store.get("run_x")!.inbox).toEqual(["A pending report notice"]);
    expect(f.store.get("run_x")!.managerRecoveryPrompt).toContain("Playbook Manager");
    f.controls.failSend = false;
    await f.recover();
    expect(f.created).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
  });

  it("marks an exhausted manager durably when no configured target remains", async () => {
    const f = await setup({ noFallback: true });
    expect(await f.recover()).toMatchObject({ changed: false, blocked: true });
    await f.runtime.deliver("run_x");
    await f.runtime.onManagerTurnEnded("m");
    expect(f.sent).toEqual([]);
    expect(f.created).toEqual([]);
    const reloaded = new RunStore(path.join(f.dir, "runs"));
    await reloaded.init();
    expect(reloaded.get("run_x")!.managerQuotaBlockedId).toBe("m");
  });

  it("uses providers.fallback without importing another provider's thinking", async () => {
    const f = await setup({ providerFallback: true });
    expect(await f.recover()).toMatchObject({ target: "codex/gpt-5-mini", thinking: null });
  });

  it("skips exhausted targets and refuses arbitrary model upgrades", async () => {
    const f = await setup();
    await expect(f.recover("codex/gpt-6-max")).rejects.toThrow(/configured manager fallback/);
    expect(f.created).toEqual([]);
    await f.store.mutate("run_x", (run) => run.exhausted.push({ target: "codex/gpt-5-mini", at: new Date().toISOString() }));
    expect(await f.recover()).toMatchObject({ blocked: true });
    expect(f.created).toEqual([]);
  });

  for (const status of ["running", "initializing"] as const) {
    it(`refuses a ${status} manager`, async () => {
      const f = await setup();
      f.manager.status = status;
      await expect(f.recover()).rejects.toThrow(/active/);
      expect(f.created).toEqual([]);
    });
  }

  it("refuses pending permissions and paused/ended runs", async () => {
    const f = await setup();
    f.manager.pendingPermissions.push({ id: "p" });
    await expect(f.recover()).rejects.toThrow(/question\/permission/);
    f.manager.pendingPermissions = [];
    await f.store.mutate("run_x", (run) => { run.status = "completed"; });
    await expect(f.recover()).rejects.toThrow(/active/);
    expect(f.created).toEqual([]);
  });

  it("refuses a manager that becomes active while the replacement is being created", async () => {
    const f = await setup();
    let release!: () => void;
    f.controls.createWait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { f.controls.createStarted = resolve; });
    const operation = f.recover();
    await started;
    f.manager.status = "running";
    release();
    expect(await operation).toMatchObject({ blocked: true });
    expect(f.store.get("run_x")!.managerAgentId).toBe("m");
    expect(f.sent).toEqual([]);
    expect(f.archived).not.toContain("m");
  });

  it("refuses paused runs and agent-bound questions without changing their gates", async () => {
    const f = await setup();
    await f.store.mutate("run_x", (run) => { run.pausedAt = new Date().toISOString(); });
    await expect(f.recover()).rejects.toThrow(/paused/);
    await f.store.mutate("run_x", (run) => {
      run.pausedAt = null;
      run.gates.push(GateSchema.parse({ id: "g", kind: "manager_question", stepId: "release", gotoTarget: null, status: "pending", message: "Review", requestedAt: new Date().toISOString(), decider: { by: "human" }, comment: null, decidedBy: null, decidedVia: null, decidedAt: null, escalated: null }));
    });
    const before = structuredClone(f.store.get("run_x")!.gates);
    await expect(f.recover()).rejects.toThrow(/original agent/);
    expect(f.store.get("run_x")!.gates).toEqual(before);
    expect(f.created).toEqual([]);
  });

  it("unblocks a manager that successfully resumes after quota resets", async () => {
    const f = await setup({ noFallback: true });
    await f.recover();
    f.setEntries([{ item: { type: "assistant_message", text: "The provider is available again; continuing." } }]);
    await f.runtime.onTurnEnded("m", "completed");
    expect(f.store.get("run_x")!.managerQuotaBlockedId).toBeNull();
    expect(f.created).toEqual([]);
  });

  it.each(["completed", "failed"] as const)("automatically recovers a confirmed quota %s manager exit", async (outcome) => {
    const f = await setup({ error: outcome === "failed" });
    await f.runtime.onTurnEnded("m", outcome);
    expect(f.created).toHaveLength(1);
    expect(f.store.get("run_x")!.managerAgentId).toBe("replacement-1");
  });

  it.each(["completed", "failed", "canceled"] as const)("does not recover an ordinary %s exit or an old quota notice", async (outcome) => {
    const f = await setup();
    f.setEntries([{ item: { type: "error", message: "quota exceeded" } }, { item: { type: "user_message", text: "try again" } }, { item: { type: "assistant_message", text: "A normal finish" } }]);
    await f.runtime.onTurnEnded("m", outcome);
    expect(f.created).toEqual([]);
    expect(f.store.get("run_x")!.managerAgentId).toBe("m");
  });
});
