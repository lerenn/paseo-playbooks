import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRunQuotaExemptRpc } from "../shared/contracts";
import { RunSchema, type Run } from "../shared/types";
import * as engine from "./engine";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { MANAGER_TOOL_NAMES, Runtime, STEP_TOOL_NAMES } from "./runtime";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PLAYBOOK = `
title: Work
quota_limit: { priority: 2 }
steps:
  - id: a
    role: { name: implementer, agent: { provider: claude, model: m } }
`;

/** A parent p with children c1, c2 and a grandchild g (under c1), all of one playbook whose own priority is 2. */
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "run-priority-"));
  temps.push(dir);
  const root = path.join(dir, "repo/.paseo/playbooks");
  await mkdir(path.join(root, "roles/implementer"), { recursive: true });
  await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
  await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), PLAYBOOK);
  const entry = (await loadPlaybooks(path.join(dir, "repo"))).entries.find((candidate) => candidate.id === "work")!;
  expect(entry.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const make = async (id: string, parent: string | null, seq: number) =>
    store.create(newRun({ id, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date(1_700_000_000_000 + seq).toISOString(), ...(parent ? { parent: { runId: parent, stepId: "fan", key: id } } : {}) }));
  await make("p", null, 0);
  await make("c1", "p", 1);
  await make("c2", "p", 2);
  await make("g", "c1", 3);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  const kick = vi.fn();
  (runtime as unknown as { kickLimits: () => void }).kickLimits = kick;
  const tick = vi.fn(async () => undefined);
  (runtime as unknown as { tick: () => Promise<void> }).tick = tick;
  const inner = runtime as unknown as { inheritedExemptFlag(parent: Run["parent"]): { inheritChildExempt?: boolean }; parentExempt(parent: Run["parent"]): boolean };
  return { store, runtime, kick, tick, inner, dir, playbook: entry.playbook! };
}

const exempt = (store: RunStore, id: string) => store.get(id)!.quotaExempt;
const hold = { kind: "headroom", reason: "waiting for headroom", retryAt: null, provider: "claude", window: "5h" } as const;

describe("set_run_quota_exempt / runs.set_exempt", () => {
  it("exempting a held run lifts its hold at once, writes history and an event, and starts the ready steps without waiting", async () => {
    const { store, runtime, tick } = await setup();
    await store.mutate("c2", (run) => void engine.setRateHold(run, hold, new Date().toISOString()));
    expect(store.get("c2")!.rateHold).not.toBeNull();
    const events: unknown[] = [];
    (runtime as unknown as { bus: { onEmit(fn: (event: { type: string; payload: unknown }) => void): void } }).bus.onEmit((event) => void (event.type === "run.quota_exempt_changed" && events.push(event.payload)));
    const result = await runtime.setRunQuotaExempt("c2", true, undefined, "the Runs view");
    expect(result).toMatchObject({ from: false, to: true, changed: true, cascaded: 0 });
    expect(exempt(store, "c2")).toBe(true);
    expect(store.get("c2")!.rateHold).toBeNull();
    expect(tick).toHaveBeenCalled();
    const entries = store.get("c2")!.history.filter((entry) => entry.type === "quota_exempt_changed");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toContain("limited → exempt");
    expect(entries[0]!.detail).toContain("by the Runs view");
    expect(events).toEqual([expect.objectContaining({ runId: "c2", from: false, to: true, inheritChildren: false, cascaded: 0, by: "the Runs view" })]);
  });

  it("is idempotent: the same state again changes nothing and emits nothing", async () => {
    const { store, runtime } = await setup();
    await runtime.setRunQuotaExempt("c2", true, undefined, "test");
    const again = await runtime.setRunQuotaExempt("c2", true, undefined, "test");
    expect(again.changed).toBe(false);
    expect(store.get("c2")!.history.filter((entry) => entry.type === "quota_exempt_changed")).toHaveLength(1);
  });

  it("un-exempting puts the run back under the limits for its next step, without touching a running step", async () => {
    const { store, runtime } = await setup();
    await runtime.setRunQuotaExempt("c2", true, undefined, "test");
    await store.mutate("c2", (run) => void (run.steps.a!.status = "running"));
    const result = await runtime.setRunQuotaExempt("c2", false, undefined, "agent a1");
    expect(result).toMatchObject({ from: true, to: false, changed: true });
    expect(exempt(store, "c2")).toBe(false);
    expect(store.get("c2")!.steps.a!.status).toBe("running");
    expect(store.get("c2")!.history.at(-1)!.detail).toContain("exempt → limited");
  });

  it("an exempt run is never held by the quota check, and a limited one is checked again from its next step", async () => {
    const { store, runtime } = await setup();
    const check = (id: string) => (runtime as unknown as { rateCheck(run: Run): Promise<unknown> }).rateCheck(store.get(id)!);
    await runtime.setRunQuotaExempt("c2", true, undefined, "test");
    await store.mutate("c2", (run) => void engine.setRateHold(run, hold, new Date().toISOString()));
    expect(await check("c2")).toBeNull();
    expect(store.get("c2")!.rateHold).toBeNull();
    await runtime.setRunQuotaExempt("c2", false, undefined, "test");
    expect(store.get("c2")!.quotaExempt).toBe(false);
  });

  it("with applyToChildren copies the state onto every active descendant, is sticky, and children started later carry the flag", async () => {
    const { store, runtime, inner } = await setup();
    await store.mutate("g", (run) => void (run.status = "completed"));
    const result = await runtime.setRunQuotaExempt("p", true, true, "test");
    expect(result.cascaded).toBe(2);
    expect(["p", "c1", "c2"].map((id) => exempt(store, id))).toEqual([true, true, true]);
    // A finished descendant is left alone.
    expect(exempt(store, "g")).toBe(false);
    expect(store.get("p")!.inheritChildExempt).toBe(true);
    expect(inner.inheritedExemptFlag({ runId: "p", stepId: "fan", key: "later" })).toEqual({ inheritChildExempt: true });
    expect(inner.parentExempt({ runId: "p", stepId: "fan", key: "later" })).toBe(true);
    // Sticky: the next change passes down again without the flag being sent.
    await runtime.setRunQuotaExempt("p", false, undefined, "test");
    expect(["p", "c1", "c2"].map((id) => exempt(store, id))).toEqual([false, false, false]);
    // Stopping: the children keep what they have.
    await runtime.setRunQuotaExempt("p", true, false, "test");
    expect(store.get("p")!.inheritChildExempt).toBe(false);
    expect(["c1", "c2"].map((id) => exempt(store, id))).toEqual([false, false]);
    expect(inner.inheritedExemptFlag({ runId: "p", stepId: "fan", key: "later" })).toEqual({});
  });

  it("without the flag the children are untouched; the priority's flag is independent", async () => {
    const { store, runtime } = await setup();
    await runtime.setRunPriority("p", 5, true, "test");
    await runtime.setRunQuotaExempt("p", true, undefined, "test");
    expect(["c1", "c2", "g"].map((id) => exempt(store, id))).toEqual([false, false, false]);
    expect(store.get("p")!.inheritChildPriority).toBe(true);
    expect(store.get("p")!.inheritChildExempt).toBe(false);
  });

  it("survives a cycle between runs", async () => {
    const { store, runtime } = await setup();
    await store.mutate("p", (run) => void (run.parent = { runId: "g", stepId: "fan", key: "p" }));
    const result = await runtime.setRunQuotaExempt("p", true, true, "test");
    expect(result.cascaded).toBe(3);
  });

  it("refuses an unknown, archived or finished run", async () => {
    const { store, runtime } = await setup();
    await expect(runtime.setRunQuotaExempt("nope", true, undefined, "test")).rejects.toThrow(/unknown run/);
    await store.mutate("c2", (run) => void (run.archivedAt = new Date().toISOString()));
    await expect(runtime.setRunQuotaExempt("c2", true, undefined, "test")).rejects.toThrow(/archived/);
    await store.mutate("c1", (run) => void (run.status = "completed"));
    await expect(runtime.setRunQuotaExempt("c1", true, undefined, "test")).rejects.toThrow(/finished/);
    expect(exempt(store, "c1")).toBe(false);
  });

  it("the Runs view gets a view for an exempt run even where pacing is off, and the manager tools carry the tool", async () => {
    const { store, runtime } = await setup();
    await runtime.setRunQuotaExempt("c2", true, undefined, "test");
    const views = await runtime.priorityViews(store.list());
    expect(views.get("c2")).toMatchObject({ exempt: true, inheritChildExempt: false });
    expect(views.has("c1")).toBe(false);
    expect(MANAGER_TOOL_NAMES).toContain("set_run_quota_exempt");
    expect(STEP_TOOL_NAMES).not.toContain("set_run_quota_exempt");
  });

  it("the RPC takes a boolean and an optional children flag; an older run loads with no inheritance", async () => {
    const parse = (input: unknown) => setRunQuotaExemptRpc.input.safeParse(input).success;
    expect(parse({ runId: "r", exempt: true })).toBe(true);
    expect(parse({ runId: "r", exempt: false, applyToChildren: true })).toBe(true);
    expect(parse({ runId: "r" })).toBe(false);
    expect(parse({ runId: "r", exempt: "yes" })).toBe(false);
    const { store } = await setup();
    const saved = JSON.parse(JSON.stringify(store.get("p"))) as Record<string, unknown>;
    delete saved.inheritChildExempt;
    expect(RunSchema.parse(saved).inheritChildExempt).toBe(false);
  });
});
