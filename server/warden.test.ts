import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WARDEN, GateSchema, type Gate, type Run } from "../shared/types";
import { newRun, noteEvent, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { diffFindings, heldMs, stalledCandidates, stalledInfo, WARDEN_MAX_RUNS_PER_PASS } from "./warden";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T10:00:00Z");
const PLAYBOOK = (warden: string) => `
title: Release
${warden}
steps:
  - id: release
    role: { name: implementer }
    outputs: { pr: {} }
`;

function fakePaseo() {
  const sent: Array<{ agentId: string; text: string }> = [];
  const status = { m: "idle", sk: "idle" } as Record<string, string>;
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: status[agentId] ?? "running", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  return { paseo: { agents: { ref, list: async () => ({ entries: [] }) } }, sent, status };
}

async function setup(warden: string, options: { sidekick?: boolean; runs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "warden-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(root, { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "release.yaml"), PLAYBOOK(warden));
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "release")!.playbook!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const mk = (id: string) => {
    const run = newRun({ id, playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date(T0).toISOString() });
    startAttempt(run, "release", { agentId: `a-${id}`, brief: "", now: new Date(T0).toISOString(), readonlySnapshot: null });
    return run;
  };
  for (let i = 0; i < (options.runs ?? 1); i++) await store.create(mk(i === 0 ? "run_x" : `run_${i}`));
  if (options.sidekick) await writeFile(path.join(dir, "sidekick.json"), JSON.stringify({ p: { workspaceId: "ws-sk", agentId: "sk" } }));
  const fake = fakePaseo();
  const runtime = new Runtime(store, { debounceMs: 0, dataDir: dir } as never);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  const bus = (runtime as unknown as { bus: { recent: (q: object) => Promise<{ events: Array<{ payload: Record<string, unknown> }> }> } }).bus;
  const events = async (type: string) => (await bus.recent({ types: [type] })).events;
  const gate = (decider: Gate["decider"], requestedAt = new Date(T0).toISOString(), escalated: string | null = null) =>
    store.mutate("run_x", (run) => {
      run.gates.push(GateSchema.parse({ id: "g1", kind: "gate", stepId: "release", gotoTarget: null, status: "pending", message: "ok?", requestedAt, comment: null, decidedBy: null, decidedVia: null, decider, escalated, decidedAt: null }));
    });
  const spies = {
    origin: vi.spyOn(runtime as never, "wardenOriginSha" as never),
    refresh: vi.spyOn(runtime, "refreshScripts").mockResolvedValue({} as never),
  };
  const isolate = (sha: string | null) =>
    store.mutate("run_x", (run: Run) => {
      run.worktree = { path: "/x", branch: "b", base: "origin/main", baseSha: "aaa", linked: [], workspaceSnapshot: null, state: "active" };
      run.definition = { source: "origin", ref: "origin/main", sha, note: null, warning: null };
    });
  /** One look at `minutes` after T0. */
  const look = (minutes: number) => runtime.watchEvents(T0 + minutes * MIN);
  return { store, runtime, sent: fake.sent, status: fake.status, events, gate, look, spies, isolate, dir };
}

/** What the warden itself sent to an agent: nothing, except its one summary to a Sidekick. */
const wardenSends = (sent: Array<{ agentId: string; text: string }>) => sent.filter((entry) => /warden/i.test(entry.text));

const ON = (checks = "") => `warden: { enabled: true${checks ? `, checks: ${checks}` : ""} }`;

describe("the warden is off by default", () => {
  it("defaults to disabled in the schema defaults", () => {
    expect(DEFAULT_WARDEN.enabled).toBe(false);
  });

  it("with no block, and with enabled: false, nothing happens: no finding, event, git read, agent read or message", async () => {
    for (const block of ["", "warden: { enabled: false }", "warden: { enabled: false, checks: { loops: { above: 1 } } }"]) {
      const s = await setup(block, { sidekick: true });
      expect(s.store.get("run_x")!.playbook.warden.enabled).toBe(false);
      await s.isolate("old");
      await s.gate({ by: "manager" });
      await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 99));
      s.sent.length = 0;
      await s.look(24 * 60);
      expect(s.store.get("run_x")!.warden.findings).toEqual({});
      expect(await s.events("warden.finding")).toHaveLength(0);
      expect(s.spies.origin).not.toHaveBeenCalled();
      expect(s.spies.refresh).not.toHaveBeenCalled();
      expect(s.sent).toHaveLength(0);
    }
  });
});

describe("the warden config", () => {
  it("resolves defaults and per-field overrides, and refuses bad values", async () => {
    const s = await setup("warden: { enabled: true, interval: 5m, cooldown: 2h, checks: { loops: { above: 3, action: none }, gate_open: { after: 10m }, stale_definition: { action: refresh_scripts } } }");
    const w = s.store.get("run_x")!.playbook.warden;
    expect(w).toMatchObject({ enabled: true, intervalMs: 5 * MIN, cooldownMs: 120 * MIN });
    expect(w.checks.loops).toEqual({ above: 3, action: "none" });
    expect(w.checks.gateOpen).toEqual({ afterMs: 10 * MIN, action: "report" });
    expect(w.checks.staleDefinition.action).toBe("refresh_scripts");
    expect(w.checks.slow.action).toBe("report");
    const dir = await mkdtemp(path.join(tmpdir(), "warden-bad-"));
    temps.push(dir);
    await mkdir(path.join(dir, ".paseo/playbooks"), { recursive: true });
    await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(dir, ".paseo/playbooks/roles"), { recursive: true });
    for (const [block, message] of [
      ["warden: { interval: soon }", /warden.interval: expected a duration/],
      ["warden: { checks: { loops: { action: refresh_scripts } } }", /only applies to stale_definition/],
      ["warden: { checks: { nope: {} } }", /nope|Unrecognized/],
      ["warden: { enabled: true, speed: 1 }", /speed|Unrecognized/],
    ] as const) {
      await writeFile(path.join(dir, ".paseo/playbooks/bad.yaml"), PLAYBOOK(block));
      const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "bad")!;
      expect(entry.errors.join("\n"), block).toMatch(message);
    }
  });
});

describe("the checks", () => {
  it("loops: detects an edge fired more than `above` times, and not at the limit", async () => {
    const s = await setup(ON("{ loops: { above: 5 } }"));
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 5));
    await s.look(0);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual([]);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 6));
    await s.look(20);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["loops:a->b"]);
    expect(await s.events("warden.finding")).toHaveLength(1);
  });

  it("gate_open: detects a gate open longer than `after`, and uses gate.stale's age", async () => {
    const s = await setup(ON("{ gate_open: { after: 30m } }"));
    await s.gate({ by: "human" });
    await s.look(20);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.look(45);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["gate_open:g1"]);
    // step.slow and gate.stale announce these: the warden adds no event of its own.
    expect(await s.events("warden.finding")).toHaveLength(0);
  });

  it("manager_blocked: a gate the manager holds while it is idle; any open gate while it is gone; not a human gate, not a busy manager", async () => {
    const s = await setup(ON("{ manager_blocked: {}, gate_open: { action: none } }"));
    await s.gate({ by: "human" });
    await s.look(0);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.store.mutate("run_x", (run) => void (run.gates[0]!.status = "approved" as never));
    await s.gate({ by: "manager" });
    s.status.m = "running";
    await s.look(20);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    s.status.m = "idle";
    await s.runtime.onManagerTurnEnded("m"); // the plugin's own wake-up turn is over
    await s.look(40);
    expect(Object.values(s.store.get("run_x")!.warden.findings).map((f) => f.detail).join()).toMatch(/manager is idle/);
    expect(await s.events("warden.finding")).toHaveLength(1);
  });

  it("manager_blocked: a gone manager with a human gate open", async () => {
    const s = await setup(ON("{ manager_blocked: {}, gate_open: { action: none } }"));
    await s.gate({ by: "human" });
    s.status.m = "closed";
    await s.look(0);
    expect(Object.values(s.store.get("run_x")!.warden.findings).map((f) => f.detail).join()).toMatch(/manager is gone/);
  });

  it("slow: detects through the slow-step index, and not a step within its baseline", async () => {
    const s = await setup(ON("{ slow: {} }"));
    await s.look(5);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    const { SlowIndex } = await import("./slow");
    vi.spyOn(SlowIndex.prototype, "of").mockReturnValue({ release: { elapsedMs: 30 * MIN, baselineMs: 5 * MIN, ratio: 6, samples: 5 } });
    await s.look(30);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["slow:release"]);
    expect(await s.events("warden.finding")).toHaveLength(0);
  });

  it("stale_definition: an older sha or the workspace checkout is found; the current sha is not; not on a non-isolated run", async () => {
    const s = await setup(ON());
    await s.look(0); // not isolated: no worktree, no definition
    expect(s.spies.origin).not.toHaveBeenCalled();
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.look(20); // pinned only 20 min: a healthy run on a slightly older origin is not reported
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.look(13 * 60); // past the 12 h default
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["stale_definition:"]);
    await s.isolate("new");
    await s.look(14 * 60);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.store.mutate("run_x", (run) => void (run.definition = { source: "workspace", ref: null, sha: null, note: "x", warning: "w" }));
    await s.look(15 * 60); // the workspace checkout case is not aged
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["stale_definition:"]);
  });

  it("stale_definition.after sets the age", async () => {
    const s = await setup(ON("{ stale_definition: { after: 30m } }"));
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.look(20);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.look(40);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["stale_definition:"]);
  });

  it("each check can be turned off with action: none", async () => {
    const s = await setup(ON("{ loops: { above: 1, action: none }, stale_definition: { action: none } }"));
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(0);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    expect(s.spies.origin).not.toHaveBeenCalled();
  });
});

describe("actions", () => {
  it("refresh_scripts runs for a stale definition, once per finding, with no message to any agent", async () => {
    const s = await setup(ON("{ stale_definition: { after: 1m, action: refresh_scripts } }"));
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.look(2);
    expect(s.spies.refresh).toHaveBeenCalledTimes(1);
    expect(s.spies.refresh.mock.calls[0]![2]).toBe("warden");
    await s.look(20);
    await s.look(120); // cooldown passed: reported again, not refreshed again
    expect(s.spies.refresh).toHaveBeenCalledTimes(1);
    s.spies.origin.mockResolvedValue("newer"); // a new finding
    await s.look(140);
    expect(s.spies.refresh).toHaveBeenCalledTimes(2);
    expect(wardenSends(s.sent)).toHaveLength(0);
  });

  it("report does not refresh anything and never prompts an agent", async () => {
    const s = await setup(ON("{ loops: { above: 1 } }"), { sidekick: false });
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(0);
    expect(s.spies.refresh).not.toHaveBeenCalled();
    expect(wardenSends(s.sent)).toHaveLength(0);
  });
});

describe("dedup and cooldown", () => {
  it("reports once, again after the cooldown, not when it clears and comes back too soon... and re-raises after clearing", async () => {
    const s = await setup(ON("{ loops: { above: 1 } }"));
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(0);
    await s.look(20);
    await s.look(40);
    expect(await s.events("warden.finding")).toHaveLength(1);
    await s.look(61); // cooldown 1h, but the count did not grow: not repeated
    expect(await s.events("warden.finding")).toHaveLength(1);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 18));
    await s.look(80); // doubled
    expect(await s.events("warden.finding")).toHaveLength(2);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 0));
    await s.look(100);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(120);
    expect(await s.events("warden.finding")).toHaveLength(3);
  });

  it("a restart does not repeat a report: the state is in the run", async () => {
    const s = await setup(ON("{ loops: { above: 1 } }"));
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(0);
    const reportedAt = Object.values(s.store.get("run_x")!.warden.findings)[0]!.reportedAt;
    const again = new Runtime(s.store, { debounceMs: 0, dataDir: s.dir } as never);
    runtimes.push(again);
    await again.attach(fakePaseo().paseo as never);
    await again.watchEvents(T0 + 20 * MIN);
    expect(Object.values(s.store.get("run_x")!.warden.findings)[0]!.reportedAt).toBe(reportedAt);
  });

  it("diffFindings: a changed signature is new at once; unchanged keeps `since`", () => {
    const iso = (m: number) => new Date(T0 + m * MIN).toISOString();
    const c = (signature: string) => ({ check: "loops" as const, subject: "e", signature, detail: "d", action: "report" as const });
    const first = diffFindings({}, [c("s1")], iso(0), 60 * MIN);
    expect(first.report).toHaveLength(1);
    const same = diffFindings(first.next, [c("s1")], iso(10), 60 * MIN);
    expect(same.report).toHaveLength(0);
    expect(same.next["loops:e"]!.since).toBe(iso(0));
    expect(diffFindings(same.next, [c("s2")], iso(11), 60 * MIN).report).toHaveLength(1);
  });
});

describe("the Sidekick summary", () => {
  const summaries = (sent: Array<{ agentId: string; text: string }>) => sent.filter((entry) => entry.agentId === "sk");

  it("sends ONE summary per pass with only the new findings, none when nothing is new, none without a Sidekick", async () => {
    const s = await setup(ON("{ loops: { above: 1 }, gate_open: { after: 10m } }"), { sidekick: true });
    await s.gate({ by: "human" });
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(20);
    expect(summaries(s.sent)).toHaveLength(1);
    expect(summaries(s.sent)[0]!.text).toMatch(/warden found 2 things/);
    await s.look(40);
    expect(summaries(s.sent)).toHaveLength(1);
    await s.store.mutate("run_x", (run) => void (run.loops["c->d"] = 7));
    await s.look(60);
    expect(summaries(s.sent)).toHaveLength(2);
    expect(summaries(s.sent)[1]!.text).toMatch(/warden found 1 thing/);
    expect(summaries(s.sent)[1]!.text).toMatch(/c->d/);
    expect(summaries(s.sent)[1]!.text).not.toMatch(/a->b/);
    const none = await setup(ON("{ loops: { above: 1 } }"));
    await none.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await none.look(0);
    expect(wardenSends(none.sent)).toHaveLength(0);
    expect(await none.events("warden.finding")).toHaveLength(1);
  });

  it("holds the summary while the Sidekick is busy", async () => {
    const s = await setup(ON("{ loops: { above: 1 } }"), { sidekick: true });
    s.status.sk = "running";
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(0);
    expect(summaries(s.sent)).toHaveLength(0);
    const held = (s.runtime as unknown as { sidekickHeld: Map<string, string[]> }).sidekickHeld;
    expect(held.get("sk")?.[0]).toMatch(/warden found/);
  });
});

describe("robustness", () => {
  it("a failing check does not stop the others", async () => {
    const s = await setup(ON("{ loops: { above: 1 }, stale_definition: {} }"));
    await s.isolate("old");
    s.spies.origin.mockRejectedValue(new Error("git exploded"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(0);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["loops:a->b"]);
    expect(error.mock.calls.flat().join(" ")).toMatch(/stale_definition failed/);
  });

  it("looks at a run only once per interval, and at most WARDEN_MAX_RUNS_PER_PASS runs per pass", async () => {
    const s = await setup(ON("{ loops: { above: 1 } }"), { runs: WARDEN_MAX_RUNS_PER_PASS + 5 });
    for (const run of s.store.list()) await s.store.mutate(run.id, (r) => void (r.loops["a->b"] = 9));
    await s.look(0);
    const reported = () => s.store.list().filter((run) => Object.keys(run.warden.findings).length > 0).length;
    expect(reported()).toBe(WARDEN_MAX_RUNS_PER_PASS);
    await s.look(1); // the rest next pass (the first ones are not due yet)
    expect(reported()).toBe(WARDEN_MAX_RUNS_PER_PASS + 5);
  });
});

describe("stalled", () => {
  const settle = (s: Awaited<ReturnType<typeof setup>>, status = "reported") =>
    s.store.mutate("run_x", (run) => void (run.steps.release!.status = status as never));
  const findings = (s: Awaited<ReturnType<typeof setup>>) => Object.values(s.store.get("run_x")!.warden.findings);

  it("is on by default, with a 30m threshold, and is configurable", async () => {
    expect(DEFAULT_WARDEN.checks.stalled).toEqual({ afterMs: 30 * MIN, action: "report" });
    const s = await setup(ON("{ stalled: { after: 2h } }"));
    expect(s.store.get("run_x")!.playbook.warden.checks.stalled).toEqual({ afterMs: 120 * MIN, action: "report" });
    const off = await setup(ON("{ stalled: { action: none } }"));
    await settle(off);
    await off.look(600);
    expect(off.store.get("run_x")!.warden.findings).toEqual({});
  });

  it("reports an active run with nothing running, ready, queued or open, once it exceeds the threshold, with manager state and last event", async () => {
    const s = await setup(ON("{ stalled: {} }"));
    await settle(s);
    await s.look(20);
    expect(findings(s)).toEqual([]);
    s.status.m = "closed";
    await s.look(40);
    const [found] = findings(s);
    expect(found).toMatchObject({ check: "stalled", subject: null });
    expect(found!.detail).toMatch(/no running, ready or queued step and no open gate for 40 min; the manager is gone; last: .* at 2026-11-18T10:00:00.*steps reported: release/);
    expect(await s.events("warden.finding")).toHaveLength(1);
  });

  it("is not stalled while a step runs, is ready, is queued, or a gate is open", async () => {
    for (const status of ["running", "ready", "queued", "waiting"]) {
      const s = await setup(ON("{ stalled: {}, gate_open: { action: none } }"));
      await settle(s, status);
      await s.look(600);
      expect(findings(s)).toEqual([]);
    }
    const s = await setup(ON("{ stalled: {}, gate_open: { action: none } }"));
    await settle(s);
    await s.gate({ by: "human" });
    await s.look(600);
    expect(findings(s)).toEqual([]);
  });

  it("names a quota-blocked manager", () => {
    const info = { idleSince: T0, last: "step_reported on review (changes_requested) at x", steps: "reported: review" };
    const [c] = stalledCandidates({} as Run, info, 30 * MIN, T0 + 9 * 60 * MIN, "idle", true, "report");
    expect(c!.detail).toMatch(/for 540 min; the manager is quota-blocked; last: step_reported on review/);
    expect(stalledCandidates({} as Run, info, 30 * MIN, T0 + 29 * MIN, "idle", true, "report")).toEqual([]);
    expect(stalledCandidates({} as Run, null, 30 * MIN, T0 + 99 * MIN, "idle", true, "report")).toEqual([]);
  });

  it("is not reported for a paused or finished run", async () => {
    const s = await setup(ON("{ stalled: {} }"));
    await settle(s);
    await s.store.mutate("run_x", (run) => void (run.pausedAt = new Date(T0).toISOString()));
    expect(stalledInfo(s.store.get("run_x")!)).toBeNull();
    await s.look(600);
    expect(findings(s)).toEqual([]);
  });

  it("repeats only when the idle time doubled or the manager state changed (cooldown 1h as minimum)", async () => {
    const s = await setup(ON("{ stalled: {} }"));
    await settle(s);
    await s.look(30); // reported at 30
    for (const m of [60, 75, 89]) await s.look(m); // doubled at 60 but within the cooldown
    expect(await s.events("warden.finding")).toHaveLength(1);
    await s.look(90); // cooldown passed, idle time 3x
    expect(await s.events("warden.finding")).toHaveLength(2);
    for (const m of [120, 150, 175]) await s.look(m); // not doubled since 90
    expect(await s.events("warden.finding")).toHaveLength(2);
    await s.look(195); // idle 195 >= 2 x 90
    expect(await s.events("warden.finding")).toHaveLength(3);
    s.status.m = "closed"; // state changed (idle -> gone), past the cooldown
    await s.look(260);
    expect(await s.events("warden.finding")).toHaveLength(4);
  });
});

describe("repeat suppression", () => {
  const iso = (m: number) => new Date(T0 + m * MIN).toISOString();
  const loop = (value: number) => ({ check: "loops" as const, subject: "e", signature: "e", detail: `d${value}`, action: "report" as const, value });

  it("diffFindings: a still-true loop is reported again only once its count doubled, and not before the cooldown", () => {
    let state = diffFindings({}, [loop(6)], iso(0), 60 * MIN).next;
    expect(diffFindings(state, [loop(11)], iso(120), 60 * MIN).report).toHaveLength(0);
    const again = diffFindings(state, [loop(12)], iso(30), 60 * MIN);
    expect(again.report).toHaveLength(0); // doubled but within the cooldown
    expect(again.next["loops:e"]!.value).toBe(6); // the baseline stays at the last report
    expect(again.next["loops:e"]!.detail).toBe("d12");
    const due = diffFindings(state, [loop(12)], iso(61), 60 * MIN);
    expect(due.report).toHaveLength(1);
    state = due.next;
    expect(state["loops:e"]!.value).toBe(12);
    expect(diffFindings(state, [loop(23)], iso(200), 60 * MIN).report).toHaveLength(0);
    expect(diffFindings(state, [loop(24)], iso(200), 60 * MIN).report).toHaveLength(1);
  });

  it("diffFindings: a state change is reported after the cooldown; a finding with neither still repeats every cooldown", () => {
    const c = (state: string) => ({ check: "stale_definition" as const, subject: null, signature: "s", detail: "d", action: "report" as const, state });
    const first = diffFindings({}, [c("running")], iso(0), 60 * MIN).next;
    expect(diffFindings(first, [c("running")], iso(120), 60 * MIN).report).toHaveLength(0);
    expect(diffFindings(first, [c("paused")], iso(30), 60 * MIN).report).toHaveLength(0);
    expect(diffFindings(first, [c("paused")], iso(61), 60 * MIN).report).toHaveLength(1);
    const plain = { check: "manager_blocked" as const, subject: "g", signature: "g", detail: "d", action: "report" as const };
    const p = diffFindings({}, [plain], iso(0), 60 * MIN).next;
    expect(diffFindings(p, [plain], iso(61), 60 * MIN).report).toHaveLength(1);
  });

  it("a loop that stays in a known long loop is not reported every cooldown", async () => {
    const s = await setup(ON("{ loops: { above: 1 } }"));
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 6));
    await s.look(0);
    for (const m of [61, 122, 183, 244]) await s.look(m);
    expect(await s.events("warden.finding")).toHaveLength(1);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 12));
    await s.look(305);
    expect(await s.events("warden.finding")).toHaveLength(2);
  });

  it("stale_definition is never reported for a run only waiting on a gate, and its repeats follow state, not the cooldown", async () => {
    const s = await setup(ON("{ stale_definition: { after: 1m }, gate_open: { action: none } }"));
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.store.mutate("run_x", (run) => void (run.steps.release!.status = "reported" as never));
    await s.gate({ by: "human" });
    await s.look(30);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.store.mutate("run_x", (run) => void (run.steps.release!.status = "running" as never));
    await s.look(60);
    expect(Object.keys(s.store.get("run_x")!.warden.findings)).toEqual(["stale_definition:"]);
    await s.look(200);
    await s.look(400);
    expect(await s.events("warden.finding")).toHaveLength(1);
    await s.store.mutate("run_x", (run) => void (run.pausedAt = new Date(T0).toISOString()));
    await s.look(600); // state changed (paused), past the cooldown
    expect(await s.events("warden.finding")).toHaveLength(2);
  });
});

describe("held runs (ADR 2026-11-23-warden-held-check)", () => {
  const at = (m: number) => new Date(T0 + m * MIN).toISOString();
  const hold = (extra: object = {}) => ({ kind: "headroom" as const, reason: "claude weekly headroom 3 below the estimated cost 12", provider: "claude", window: "weekly", since: at(0), retryAt: at(400), estimatedCost: 12, headroom: 3, position: 2, priority: 5, ...extra });
  const holdRun = (s: Awaited<ReturnType<typeof setup>>, id = "run_x", extra: object = {}) =>
    s.store.mutate(id, (run) => {
      run.steps.release!.status = "ready";
      run.rateHold = hold(extra);
    });
  const findings = (s: Awaited<ReturnType<typeof setup>>, id = "run_x") => Object.values(s.store.get(id)!.warden.findings);

  it("held is on by default with a 2h threshold, and is configurable", async () => {
    expect(DEFAULT_WARDEN.checks.held).toEqual({ afterMs: 120 * MIN, action: "report" });
    const s = await setup(ON("{ held: { after: 1h } }"));
    expect(s.store.get("run_x")!.playbook.warden.checks.held).toEqual({ afterMs: 60 * MIN, action: "report" });
    const off = await setup(ON("{ held: { action: none } }"));
    await holdRun(off);
    await off.look(600);
    expect(off.store.get("run_x")!.warden.findings).toEqual({});
  });

  it("reports a run held longer than `after`, with reason, provider and window, queue place, who is ahead, cost and retry time", async () => {
    const s = await setup(ON("{ held: {}, stalled: { action: none } }"), { runs: 2 });
    await holdRun(s);
    await holdRun(s, "run_1", { position: 1, priority: 9 });
    await s.look(100);
    expect(findings(s)).toEqual([]);
    await s.look(130);
    const [found] = findings(s);
    expect(found).toMatchObject({ check: "held", subject: null, value: 130, state: "headroom" });
    expect(found!.detail).toContain("held 130 min for quota (headroom: claude weekly headroom 3 below the estimated cost 12)");
    expect(found!.detail).toContain("claude weekly; position 2, priority 5; ahead: run_1 (release); estimated cost 12 vs headroom 3; retry at " + at(400));
    expect(await s.events("warden.finding")).toHaveLength(2); // run_1 (position 1, nobody ahead) is reported too
    expect(findings(s, "run_1")[0]!.detail).toContain("no other held run ahead");
  });

  it("is not reported for a run paused by a human, or one that is not held", async () => {
    const s = await setup(ON("{ held: {} }"));
    await holdRun(s);
    await s.store.mutate("run_x", (run) => void (run.pausedAt = at(10)));
    await s.look(600);
    expect(findings(s)).toEqual([]);
    const free = await setup(ON("{ held: {} }"));
    await free.look(600);
    expect(findings(free).filter((f) => f.check === "held")).toEqual([]);
  });

  it("repeats on the doubling rule (value = hold minutes) and when the hold kind changes", async () => {
    const s = await setup(ON("{ held: {}, stalled: { action: none } }"));
    await holdRun(s);
    await s.look(120);
    for (const m of [150, 200, 239]) await s.look(m);
    expect(await s.events("warden.finding")).toHaveLength(1);
    await s.look(255);
    expect(await s.events("warden.finding")).toHaveLength(2);
    await s.store.mutate("run_x", (run) => void (run.rateHold = { ...run.rateHold!, kind: "pace" }));
    await s.look(330); // past the cooldown, kind changed
    expect(await s.events("warden.finding")).toHaveLength(3);
  });

  it("heldMs sums the closed holds and the open one", async () => {
    const s = await setup(ON());
    await s.store.mutate("run_x", (run) => {
      noteEvent(run, "run_held", null, "x", at(10));
      noteEvent(run, "run_released", null, "x", at(40));
      run.rateHold = hold({ since: at(100) });
    });
    expect(heldMs(s.store.get("run_x")!, T0 + 160 * MIN)).toBe(90 * MIN);
  });

  it("stalled: a held run is never stalled, and its idle clock starts at the release", async () => {
    const s = await setup(ON("{ stalled: {}, held: { action: none } }"));
    await s.store.mutate("run_x", (run) => {
      run.steps.release!.status = "reported";
      run.rateHold = hold();
    });
    expect(stalledInfo(s.store.get("run_x")!)).toBeNull();
    await s.look(600);
    expect(findings(s)).toEqual([]);
    await s.store.mutate("run_x", (run) => {
      run.rateHold = null;
      noteEvent(run, "run_released", null, "lifted", at(600));
    });
    await s.look(620);
    expect(findings(s)).toEqual([]);
    await s.look(640);
    expect(findings(s)[0]).toMatchObject({ check: "stalled" });
    expect(findings(s)[0]!.detail).toContain("for 40 min");
  });

  it("stale_definition: time spent held does not age the pin", async () => {
    const s = await setup(ON("{ held: { action: none } }"));
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.store.mutate("run_x", (run) => {
      noteEvent(run, "run_held", null, "x", at(0));
      noteEvent(run, "run_released", null, "x", at(11 * 60));
    });
    await s.look(13 * 60); // 13h old, 11h of it held: 2h of age
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.store.mutate("run_x", (run) => void (run.rateHold = hold({ since: at(13 * 60) })));
    await s.look(25 * 60); // 24h old, 11h + 12h held: 1h of age
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.look(40 * 60); // the hold now lasts 27h: still 1h of age
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
  });

  it("stale_definition: the state that drives repeats ignores the hold, so a held run does not re-report when it flips", async () => {
    const s = await setup(ON("{ held: { action: none } }"));
    await s.isolate("old");
    s.spies.origin.mockResolvedValue("new");
    await s.look(13 * 60);
    expect(await s.events("warden.finding")).toHaveLength(1);
    await holdRun(s);
    await s.look(15 * 60);
    expect(await s.events("warden.finding")).toHaveLength(1);
  });

  it("loops, gate_open and manager_blocked keep reporting on a held run: a hold changes none of their facts", async () => {
    const s = await setup(ON("{ loops: { above: 1 }, gate_open: { after: 30m }, manager_blocked: {}, held: { action: none } }"));
    await holdRun(s);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.gate({ by: "manager" });
    s.status.m = "closed";
    await s.look(60);
    expect(Object.keys(s.store.get("run_x")!.warden.findings).sort()).toEqual(["gate_open:g1", "loops:a->b", "manager_blocked:g1"]);
  });

  it("slow: a ready step that cannot start because of the hold is not slow", async () => {
    const s = await setup(ON("{ slow: {}, held: { action: none } }"));
    await holdRun(s);
    const { SlowIndex } = await import("./slow");
    vi.spyOn(SlowIndex.prototype, "of").mockReturnValue({ release: { elapsedMs: 30 * MIN, baselineMs: 5 * MIN, ratio: 6, samples: 5 } });
    await s.look(30);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
  });
});
