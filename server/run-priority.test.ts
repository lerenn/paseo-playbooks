import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRunPriorityRpc } from "../shared/contracts";
import { RunSchema, type Run } from "../shared/types";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { runPriority } from "./rate-limit";
import { Runtime } from "./runtime";
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
  const inner = runtime as unknown as { inheritedPriority(parent: Run["parent"]): { priorityOverride?: number; inheritChildPriority?: boolean } };
  return { store, runtime, kick, inner, dir, playbook: entry.playbook! };
}

const override = (store: RunStore, id: string) => store.get(id)!.priorityOverride;

describe("run quota priority override", () => {
  it("wins over the playbook's priority and a start_playbook priority; null clears it", async () => {
    const { store, runtime } = await setup();
    const runs = () => store.list();
    expect(runPriority(store.get("p")!, runs())).toBe(2);
    await store.mutate("p", (run) => void (run.priority = 4));
    expect(runPriority(store.get("p")!, runs())).toBe(4);
    await runtime.setRunPriority("p", 9, undefined, "test");
    expect(runPriority(store.get("p")!, runs())).toBe(9);
    // Without the flag the children are untouched and follow the parent's own priority, not its override.
    expect(override(store, "c1")).toBeNull();
    expect(runPriority(store.get("c1")!, runs())).toBe(4);
    const cleared = await runtime.setRunPriority("p", null, undefined, "test");
    expect(cleared).toMatchObject({ from: 9, to: null, changed: true });
    expect(runPriority(store.get("p")!, runs())).toBe(4);
  });

  it("is applied at once: the pace plan is looked at again, and history and an event record it", async () => {
    const { store, runtime, kick } = await setup();
    const events: unknown[] = [];
    (runtime as unknown as { bus: { onEmit(fn: (event: { type: string; payload: unknown }) => void): void } }).bus.onEmit((event) => void (event.type === "run.priority_changed" && events.push(event.payload)));
    const result = await runtime.setRunPriority("c2", 7, undefined, "the Quota limitation tab");
    expect(result).toMatchObject({ from: null, to: 7, changed: true, cascaded: 0 });
    expect(kick).toHaveBeenCalled();
    expect(store.get("c2")!.history.at(-1)).toMatchObject({ type: "priority_changed" });
    expect(store.get("c2")!.history.at(-1)!.detail).toContain("none → 7");
    expect(events).toEqual([expect.objectContaining({ runId: "c2", from: null, to: 7, inheritChildren: false, cascaded: 0 })]);
    // The same value again changes nothing: no second history entry.
    const again = await runtime.setRunPriority("c2", 7, undefined, "test");
    expect(again.changed).toBe(false);
    expect(store.get("c2")!.history.filter((entry) => entry.type === "priority_changed")).toHaveLength(1);
  });

  it("with applyToChildren copies the priority onto every descendant, and later children start with it", async () => {
    const { store, runtime, inner } = await setup();
    const result = await runtime.setRunPriority("p", 8, true, "test");
    expect(result.cascaded).toBe(3);
    for (const id of ["p", "c1", "c2", "g"]) expect(override(store, id)).toBe(8);
    expect(store.get("p")!.inheritChildPriority).toBe(true);
    // A child the parent starts later (a refill, replace_child) inherits it, and passes it to its own children.
    expect(inner.inheritedPriority({ runId: "p", stepId: "fan", key: "later" })).toEqual({ priorityOverride: 8, inheritChildPriority: true });
    // The flag is sticky: the next edit passes down again, and a clear clears the children too.
    await runtime.setRunPriority("p", 3, undefined, "test");
    expect(["c1", "c2", "g"].map((id) => override(store, id))).toEqual([3, 3, 3]);
    await runtime.setRunPriority("p", null, undefined, "test");
    expect(["p", "c1", "c2", "g"].map((id) => override(store, id))).toEqual([null, null, null, null]);
    expect(inner.inheritedPriority({ runId: "p", stepId: "fan", key: "later" })).toEqual({});
  });

  it("a child's own edit wins until the parent is edited again; unchecking stops inheriting without resetting the children", async () => {
    const { store, runtime, inner } = await setup();
    await runtime.setRunPriority("p", 8, true, "test");
    await runtime.setRunPriority("c1", 1, false, "test");
    const runs = store.list();
    expect(runPriority(store.get("c1")!, runs)).toBe(1);
    expect(runPriority(store.get("c2")!, runs)).toBe(8);
    // The child's edit did not reach its own child: its flag was turned off.
    expect(override(store, "g")).toBe(8);
    await runtime.setRunPriority("p", 6, undefined, "test");
    expect(override(store, "c1")).toBe(6);
    // Uncheck: no more inheriting, the children keep what they have.
    await runtime.setRunPriority("p", 6, false, "test");
    expect(store.get("p")!.inheritChildPriority).toBe(false);
    await runtime.setRunPriority("p", 2, undefined, "test");
    expect(["c1", "c2", "g"].map((id) => override(store, id))).toEqual([6, 6, 6]);
    expect(inner.inheritedPriority({ runId: "p", stepId: "fan", key: "later" })).toEqual({});
  });

  it("survives a cycle between runs and a chain deeper than 20", async () => {
    const { store, runtime } = await setup();
    await store.mutate("p", (run) => void (run.parent = { runId: "g", stepId: "fan", key: "p" }));
    const result = await runtime.setRunPriority("p", 5, true, "test");
    expect(result.cascaded).toBe(3);
    expect(override(store, "g")).toBe(5);
  });

  it("refuses an unknown or archived run and a priority out of range", async () => {
    const { store, runtime } = await setup();
    await expect(runtime.setRunPriority("nope", 1, undefined, "test")).rejects.toThrow(/unknown run/);
    await expect(runtime.setRunPriority("p", 1001, undefined, "test")).rejects.toThrow(/whole number/);
    await expect(runtime.setRunPriority("p", 1.5, undefined, "test")).rejects.toThrow(/whole number/);
    await store.mutate("c2", (run) => void (run.archivedAt = new Date().toISOString()));
    await expect(runtime.setRunPriority("c2", 1, undefined, "test")).rejects.toThrow(/archived/);
    expect(override(store, "p")).toBeNull();
  });

  it("the RPC validates the range like the playbook's priority", () => {
    const parse = (input: unknown) => setRunPriorityRpc.input.safeParse(input).success;
    expect(parse({ runId: "r", priority: 5 })).toBe(true);
    expect(parse({ runId: "r", priority: null, applyToChildren: true })).toBe(true);
    expect(parse({ runId: "r", priority: -1000 })).toBe(true);
    expect(parse({ runId: "r", priority: 1001 })).toBe(false);
    expect(parse({ runId: "r", priority: 1.5 })).toBe(false);
    expect(parse({ runId: "r", priority: "high" })).toBe(false);
    expect(parse({ runId: "r" })).toBe(false);
  });

  it("a run saved before the field existed loads with no override and no inheritance", async () => {
    const { store } = await setup();
    const saved = JSON.parse(JSON.stringify(store.get("p"))) as Record<string, unknown>;
    delete saved.priorityOverride;
    delete saved.inheritChildPriority;
    expect(RunSchema.parse(saved)).toMatchObject({ priorityOverride: null, inheritChildPriority: false });
  });

  it("shows in the Runs view for an active run of a project that paces: the priority now, the playbook's, the override and the children", async () => {
    const { store, runtime } = await setup();
    await runtime.setRunPriority("p", 8, true, "test");
    // Only the runs whose playbook turns pacing on get the view.
    for (const id of ["p", "c2"]) await store.mutate(id, (run) => void (run.playbook.quotaLimits = { quota: { pacing: true } }));
    const views = await runtime.priorityViews(store.list());
    expect([...views.keys()].sort()).toEqual(["c2", "p"]);
    expect(views.get("p")).toEqual({ priority: 8, defaultPriority: 2, override: 8, hasChildren: true, inheritChildren: true });
    expect(views.get("c2")).toEqual({ priority: 8, defaultPriority: 2, override: 8, hasChildren: false, inheritChildren: true });
  });

  it("has no view for a finished run", async () => {
    const { store, runtime } = await setup();
    await store.mutate("p", (run) => {
      run.playbook.quotaLimits = { quota: { pacing: true } };
      run.status = "completed";
    });
    expect((await runtime.priorityViews(store.list())).has("p")).toBe(false);
  });
});
