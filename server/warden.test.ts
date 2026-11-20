import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WARDEN, GateSchema, type Gate, type Run } from "../shared/types";
import { newRun, startAttempt } from "./engine";
import { loadPlaybooks } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { diffFindings, WARDEN_MAX_RUNS_PER_PASS } from "./warden";

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
    await s.look(61); // cooldown 1h
    expect(await s.events("warden.finding")).toHaveLength(2);
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 0));
    await s.look(80);
    expect(s.store.get("run_x")!.warden.findings).toEqual({});
    await s.store.mutate("run_x", (run) => void (run.loops["a->b"] = 9));
    await s.look(100);
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
