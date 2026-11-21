import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS } from "./config";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { CostHistory, exhaustionVerdict, orderCandidates, planHeadroom, windowKey, type Candidate, type PlanContext } from "./rate-budget";
import { admittedRunIds, windowRooms, type Probe } from "./rate-limit";
import type { Run } from "../shared/types";

const temps: string[] = [];
afterEach(async () => void (await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const usage = (used: number, elapsedHours = 50) => ({ id: "weekly", label: "weekly", usedPct: used, resetsAt: new Date(NOW + (168 - elapsedHours) * HOUR).toISOString() });

async function mk(count: number, header = ""): Promise<Run[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "budget-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "roles/implementer"), { recursive: true });
  await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
  await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), `title: Work\n${header}steps:\n  - id: a\n    role: { name: implementer, agent: { provider: claude, model: m } }\n  - id: b\n    needs: [a]\n    role: { name: implementer, agent: { provider: claude, model: m } }\n`);
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "work")!;
  expect(entry.errors).toEqual([]);
  return Array.from({ length: count }, (_, i) => newRun({ id: `r${i}`, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date(NOW + i * 1000).toISOString() }));
}

/** 50 of 168 hours gone, 97 usable: the pace ceiling is 28.9 points; usage `used` leaves 28.9 - used of headroom. */
function ctxOf(used: number | null, extra: Partial<PlanContext> = {}, reserved: Record<string, number> = {}): PlanContext {
  const probe = (): Probe => (used === null ? { state: "unreported" } : { state: "ok", rooms: windowRooms({ providerId: "claude", windows: [usage(used)] }, 97, NOW) });
  return { now: NOW, config: DEFAULT_RATE_LIMITS, probe, stepCost: () => 2, reserved: (provider, id) => reserved[windowKey(provider, id)] ?? 0, ...extra };
}
const want = (run: Run, steps = 1, priority = 0): Candidate => ({ run, priority, demand: new Map([["claude", steps]]) });

describe("headroom plan", () => {
  it("starts work while the headroom covers its estimated cost and holds the rest", async () => {
    const runs = await mk(3);
    // Headroom 28.9 - 22 = 6.9 points: three runs of 2 steps (4 points) fit one only.
    const plan = planHeadroom(runs.map((run) => want(run, 2)), ctxOf(22));
    expect([...plan.holds.keys()]).toEqual(["r1", "r2"]);
    expect(plan.holds.get("r1")).toMatchObject({ kind: "headroom", provider: "claude", window: "weekly", position: 1, estimatedCost: 4 });
    expect(plan.holds.get("r1")!.headroom).toBeCloseTo((97 * 50) / 168 - 26, 4);
    expect(plan.holds.get("r1")!.reason).toContain("insufficient quota headroom");
    expect(plan.holds.get("r1")!.reason).toContain("estimated");
    expect(plan.holds.get("r2")).toMatchObject({ position: 2 });
    expect(plan.admitted.get("r0")).toEqual({ [windowKey("claude", "weekly")]: 4 });
  });

  it("the parallelism is the result: more headroom, more work", async () => {
    const runs = await mk(3);
    expect(planHeadroom(runs.map((run) => want(run)), ctxOf(26)).holds.size).toBe(2);
    expect(planHeadroom(runs.map((run) => want(run)), ctxOf(22)).holds.size).toBe(0);
    // Usage ahead of the pace: nothing starts.
    expect(planHeadroom(runs.map((run) => want(run)), ctxOf(40)).holds.size).toBe(3);
  });

  it("reserves what started work has yet to use until the readings catch up", async () => {
    const runs = await mk(1);
    const key = windowKey("claude", "weekly");
    // 6.9 free, 5 reserved by a started run: 1.9 left, a 2-point step waits.
    expect(planHeadroom([want(runs[0]!)], ctxOf(22, {}, { [key]: 5 })).holds.get("r0")).toMatchObject({ kind: "headroom" });
    expect(planHeadroom([want(runs[0]!)], ctxOf(22, {}, { [key]: 4 })).holds.size).toBe(0);
  });

  it("uses history for the cost when there is some, else not paced by cost", async () => {
    const runs = await mk(2);
    const history = new CostHistory();
    history.add("work", "claude", { weekly: 1 });
    history.add("work", "claude", { weekly: 2 });
    expect(history.stepCost("work", "claude", "weekly")).toBe(1.5);
    expect(history.stepCost("other", "claude", "weekly")).toBeNull();
    const ctx = ctxOf(25, { stepCost: (run, provider, id) => history.stepCost(run.playbook.id, provider, id) });
    // 3.9 free: two 1.5-point steps fit, a third (4.5) does not.
    const plan = planHeadroom([want(runs[0]!, 2), want(runs[1]!, 1)], ctx);
    expect(plan.holds.get("r1")!.reason).toContain("from history");
    expect(plan.holds.get("r0")).toBeUndefined();
  });

  it("goes by priority, then oldest first, and a blocked higher run is not jumped by a smaller one", async () => {
    const runs = await mk(3);
    runs[1]!.priority = 5;
    runs[2]!.priority = 5;
    const ordered = orderCandidates([want(runs[0]!, 1, 0), want(runs[1]!, 1, 5), want(runs[2]!, 1, 5)], [runs[0]!, runs[1]!, runs[2]!]);
    expect(ordered.map((c) => c.run.id)).toEqual(["r1", "r2", "r0"]);
    // Room for one step (2 points of 2.9): r1 first, then r2 held, and r0 (smaller) must not jump r2.
    const plan = planHeadroom(ordered, ctxOf(26));
    expect([...plan.holds.keys()]).toEqual(["r2", "r0"]);
    expect(plan.holds.get("r2")!.position).toBe(1);
    expect(plan.holds.get("r0")!.position).toBe(2);
    expect(plan.holds.get("r2")!.priority).toBe(5);
  });

  it("holds above the usable percent as a quota hold until the window resets, and when data is unavailable", async () => {
    const runs = await mk(1);
    expect(planHeadroom([want(runs[0]!)], ctxOf(98)).holds.get("r0")).toMatchObject({ kind: "quota", provider: "claude", window: "weekly" });
    const none = ctxOf(10, { probe: () => ({ state: "unavailable", verdict: { kind: "quota", reason: "quota data unavailable for claude", provider: "claude", window: null, retryAt: new Date(NOW).toISOString() } }) });
    expect(planHeadroom([want(runs[0]!)], none).holds.get("r0")!.reason).toContain("unavailable");
  });

  it("does not pace by cost a playbook with no history yet: it reserves nothing, but the hard cap still holds", async () => {
    const runs = await mk(2);
    const none = (used: number) => ctxOf(used, { stepCost: () => null });
    // Usage far ahead of the pace (40 of a 28.9 ceiling): still starts, and takes nothing from the headroom.
    const plan = planHeadroom(runs.map((run) => want(run, 9)), none(40));
    expect(plan.holds.size).toBe(0);
    expect(plan.admitted.get("r0")).toEqual({ [windowKey("claude", "weekly")]: 0 });
    expect(planHeadroom(runs.map((run) => want(run)), none(98)).holds.get("r0")).toMatchObject({ kind: "quota" });
  });

  it("does not pace a provider with no usage report and says which", async () => {
    const runs = await mk(2);
    const plan = planHeadroom(runs.map((run) => want(run, 9)), ctxOf(null));
    expect(plan.holds.size).toBe(0);
    expect([...plan.unreported]).toEqual(["claude"]);
  });

  it("an admitted run is held between steps only when the quota is exhausted, never for lack of headroom", async () => {
    // Usage ahead of the pace but under the usable percent: no hold. At the usable percent: held until reset.
    expect(exhaustionVerdict(["claude"], { now: NOW, probe: ctxOf(60).probe }).verdict).toBeNull();
    expect(exhaustionVerdict(["claude"], { now: NOW, probe: ctxOf(97.5).probe }).verdict).toMatchObject({ kind: "quota", window: "weekly" });
    expect([...exhaustionVerdict(["claude"], { now: NOW, probe: ctxOf(null).probe }).unreported]).toEqual(["claude"]);
  });

  it("caps an estimate at what the window can ever hold, so a big run is still admitted at some point", async () => {
    const runs = await mk(1);
    const plan = planHeadroom([want(runs[0]!, 100)], ctxOf(0, { stepCost: () => 5 }));
    expect(plan.holds.get("r0")!.estimatedCost).toBe(97);
  });
});

describe("priority", () => {
  it("comes from the playbook's rate_limit block, overridden per run", async () => {
    const runs = await mk(2, "rate_limit: { priority: 7 }\n");
    expect(runs[0]!.playbook.rateLimit.priority).toBe(7);
    runs[1]!.priority = -3;
    const { runPriority } = await import("./rate-limit");
    expect(runPriority(runs[0]!, runs)).toBe(7);
    expect(runPriority(runs[1]!, runs)).toBe(-3);
  });

  it("orders the optional playbook cap, and never takes a place from a run that already started", async () => {
    const runs = await mk(3);
    runs[2]!.priority = 9;
    expect([...admittedRunIds(runs, 1)!]).toEqual(["r2"]);
    // r0 has started: the higher-priority newcomer does not evict it.
    runs[0]!.steps.a!.attempts.push({ n: 1, agentId: "x", startedAt: new Date(NOW).toISOString(), endedAt: null } as never);
    expect([...admittedRunIds(runs, 1)!]).toEqual(["r0"]);
  });
});
