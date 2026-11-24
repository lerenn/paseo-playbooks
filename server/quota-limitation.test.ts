import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { DEFAULT_RATE_LIMITS } from "./config";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { buildQuotaLimitation } from "./quota-limitation";
import { windowKey } from "./rate-budget";
import { QuotaPacer, type PacerView } from "./rate-limit";
import type { UsageSnapshot } from "./usage";

const temps: string[] = [];
afterEach(async () => void (await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const config = { ...DEFAULT_RATE_LIMITS, quota: { ...DEFAULT_RATE_LIMITS.quota, usablePercent: 90, pacing: true } };
const projectsOn = [{ projectId: "p", label: "App", sets: [{ repos: ["default"], config }] }];
const weekly = (usedPct: number, elapsedHours: number) => ({ id: "weekly", label: "Weekly", usedPct, resetsAt: new Date(NOW + (168 - elapsedHours) * HOUR).toISOString() });
const view = (over: Partial<PacerView> = {}): PacerView => ({ provider: "claude", state: "ok", readAt: NOW - 1000, overrideUntil: null, entry: { providerId: "claude", status: "available", windows: [weekly(60, 84)] }, usage: { available: true, since: null, lastReadAt: NOW - 1000, reason: null, failures: 0 }, ...over });

async function oneRun(): Promise<Run> {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-tab-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "roles/worker"), { recursive: true });
  await writeFile(path.join(root, "roles/worker/role.yaml"), "title: Worker\n");
  await writeFile(path.join(root, "roles/worker/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), "id: work\ntitle: Work\nsteps:\n  - id: a\n    role: { name: worker, agent: { provider: claude, model: m } }\n");
  const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "work")!;
  return newRun({ id: "r1", playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date(NOW).toISOString() });
}

describe("burn rate limiting view", () => {
  it("tags an exempt run among the reservations and never lists it as held", async () => {
    const run = { ...(await oneRun()), quotaExempt: true };
    const out = buildQuotaLimitation({ projects: projectsOn, nowMs: NOW, views: [view()], runs: [run], reservations: [{ runId: "r1", est: { [windowKey("claude", "weekly")]: 5 }, spent: {}, endedAt: null }] });
    expect(out.providers[0]!.reservations).toEqual([{ runId: "r1", projectId: "p", title: "Work", remaining: { weekly: 5 }, exempt: true }]);
    expect(out.providers[0]!.held).toEqual([]);
    expect(out.runsActive).toBe(1);
  });

  it("gives a reservation its basis (agent time left at the burn rate) and a project the burn rate rows to reset", async () => {
    const run = await oneRun();
    const burn = [{ playbook: "work", title: "Work", resetAt: null, rates: [{ provider: "claude", window: "weekly", burnRate: 6, steps: 3, lowConfidence: true }], steps: [{ id: "a", durationMs: 1_800_000, resetAt: null }] }];
    const out = buildQuotaLimitation({
      projects: [{ ...projectsOn[0]!, burnRates: burn }],
      nowMs: NOW,
      views: [view()],
      runs: [run],
      reservations: [{ runId: "r1", est: { [windowKey("claude", "weekly")]: 3 }, spent: {}, endedAt: null }],
      basis: () => ({ ms: 1_800_000, burnRate: 6 }),
    });
    expect(out.providers[0]!.reservations[0]).toMatchObject({ remaining: { weekly: 3 }, basis: { weekly: { ms: 1_800_000, burnRate: 6 } } });
    expect(out.projects[0]!.burnRates).toEqual(burn);
    // Without a basis (the need comes from step costs) the reservation carries none.
    const plain = buildQuotaLimitation({ projects: projectsOn, nowMs: NOW, views: [view()], runs: [run], reservations: [{ runId: "r1", est: { [windowKey("claude", "weekly")]: 3 }, spent: {}, endedAt: null }] });
    expect(plain.providers[0]!.reservations[0]).not.toHaveProperty("basis");
    expect(plain.projects[0]).not.toHaveProperty("burnRates");
  });

  it("shows usage, allowed so far, reservations and headroom per window", async () => {
    const run = await oneRun();
    const out = buildQuotaLimitation({
      projects: projectsOn,
      nowMs: NOW,
      views: [view()],
      runs: [run],
      reservations: [{ runId: "r1", est: { [windowKey("claude", "weekly")]: 5 }, spent: { [windowKey("claude", "weekly")]: 1 }, endedAt: null }],
    });
    const [provider] = out.providers;
    const [window] = provider!.windows;
    // Half the window is gone: the ceiling is 45 (90 * 84 / 168); usage 60 is ahead of it.
    expect(window).toMatchObject({ id: "weekly", used: 60, reserved: 4, stale: false, paces: [{ usable: 90, ceiling: 45, headroom: -15, free: -19, projects: ["App"] }] });
    expect(provider!.pacedBy).toEqual(["App"]);
    expect(provider!.reservations).toEqual([{ runId: "r1", projectId: "p", title: "Work", remaining: { weekly: 4 } }]);
    expect(out.projects).toEqual([{ projectId: "p", label: "App", limits: [{ repos: ["default"], pacing: true, usablePercent: 90, stepsLimit: null, runsLimit: null }] }]);
    expect(out.stepsRunning).toBe(0);
  });

  it("lists held runs of the provider, exhausted marks, and runs held by a cap apart", async () => {
    const run = await oneRun();
    run.rateHold = { kind: "pace", reason: "claude weekly above its allowance so far", provider: "claude", window: "weekly", since: new Date(NOW).toISOString(), retryAt: null, estimatedCost: null, headroom: null, position: null, priority: null };
    run.exhausted = [{ target: "claude/m", at: new Date(NOW - 1000).toISOString() }];
    const out = buildQuotaLimitation({ projects: projectsOn, nowMs: NOW, views: [view()], runs: [run], reservations: [] });
    expect(out.providers[0]!.held).toMatchObject([{ runId: "r1", kind: "pace", window: "weekly" }]);
    expect(out.providers[0]!.exhausted).toMatchObject([{ runId: "r1", target: "claude/m" }]);
    expect(out.limitHeld).toEqual([]);
    run.rateHold = { ...run.rateHold, kind: "steps", provider: null, window: null };
    expect(buildQuotaLimitation({ projects: projectsOn, nowMs: NOW, views: [view()], runs: [run], reservations: [] }).limitHeld).toMatchObject([{ runId: "r1", kind: "steps" }]);
  });

  it("marks a reset window stale, keeps a model window unpaced and a provider without usage listed", async () => {
    const stale = { id: "weekly", label: "Weekly", usedPct: 80, resetsAt: new Date(NOW - HOUR).toISOString() };
    const model = { id: "weekly_model_x", label: "Weekly X", usedPct: 10, resetsAt: new Date(NOW + HOUR).toISOString() };
    const out = buildQuotaLimitation({
      projects: projectsOn,
      nowMs: NOW,
      views: [view({ entry: { providerId: "claude", status: "available", windows: [stale, model] } }), view({ provider: "codex", state: "unreported", entry: null })],
      runs: [],
      reservations: [],
    });
    expect(out.providers[0]!.windows).toMatchObject([{ id: "weekly", stale: true, paces: [] }, { id: "weekly_model_x", modelScoped: true, paces: [] }]);
    expect(out.providers[1]).toMatchObject({ provider: "codex", state: "unreported", windows: [] });
  });
});

describe("burn rate limiting per project", () => {
  const off = { ...DEFAULT_RATE_LIMITS, quota: { ...DEFAULT_RATE_LIMITS.quota } };
  const at = (usablePercent: number) => ({ ...config, quota: { ...config.quota, usablePercent } });

  it("paces at each distinct percent of the projects that pace and names them", () => {
    const out = buildQuotaLimitation({
      projects: [
        { projectId: "a", label: "A", sets: [{ repos: ["default"], config: at(90) }] },
        { projectId: "b", label: "B", sets: [{ repos: ["default"], config: at(60) }, { repos: ["team"], config: at(90) }] },
        { projectId: "c", label: "C", sets: [{ repos: ["default"], config: { ...off, steps: 2 } }] },
      ],
      nowMs: NOW,
      views: [view()],
      runs: [],
      reservations: [],
    });
    expect(out.providers[0]!.pacedBy).toEqual(["A", "B"]);
    // Half the window is gone: ceiling 45 at 90%, 30 at 60%.
    expect(out.providers[0]!.windows[0]!.paces).toEqual([
      { usable: 90, ceiling: 45, headroom: -15, free: -15, projects: ["A", "B"] },
      { usable: 60, ceiling: 30, headroom: -30, free: -30, projects: ["B"] },
    ]);
    expect(out.projects.map((project) => [project.label, project.limits.map((limits) => limits.pacing)])).toEqual([["A", [true]], ["B", [true, true]], ["C", [false]]]);
    expect(out.projects[2]!.limits[0]).toMatchObject({ stepsLimit: 2, runsLimit: null });
  });

  it("is not paced when no project has pacing on", () => {
    const out = buildQuotaLimitation({ projects: [{ projectId: "c", label: "C", sets: [{ repos: [], config: off }] }], nowMs: NOW, views: [view()], runs: [], reservations: [] });
    expect(out.providers[0]!.pacedBy).toEqual([]);
    expect(out.providers[0]!.windows[0]).toMatchObject({ used: 60, paces: [] });
  });
});

describe("QuotaPacer.view", () => {
  const snapshot: UsageSnapshot = { providers: [{ providerId: "claude", status: "available", windows: [weekly(10, 10)] }] };

  it("reports ok after a read, unavailable before one, and override while it lasts", async () => {
    let now = NOW;
    const pacer = new QuotaPacer(async () => snapshot, () => undefined, () => now);
    expect(pacer.view(config.quota)).toEqual([]);
    await pacer.refresh();
    expect(pacer.view(config.quota)[0]).toMatchObject({ provider: "claude", state: "ok", readAt: NOW });
    now = NOW + config.quota.maxAgeMs + 1;
    expect(pacer.view(config.quota)[0]!.state).toBe("unavailable");
    now = NOW;
    pacer.override("claude", HOUR);
    expect(pacer.view(config.quota)[0]).toMatchObject({ state: "override", overrideUntil: NOW + HOUR });
  });
});

describe("the provider's usage state in the payload", () => {
  it("carries available, since, last read and reason per provider", () => {
    const down = { available: false, since: NOW - 3 * HOUR, lastReadAt: NOW - 4 * HOUR, reason: "HTTP 429", failures: 5 };
    const out = buildQuotaLimitation({ projects: projectsOn, nowMs: NOW, views: [view({ state: "unavailable", usage: down }), view({ provider: "codex" })], runs: [], reservations: [] });
    expect(out.providers[0]!.usage).toEqual({ available: false, since: new Date(NOW - 3 * HOUR).toISOString(), lastReadAt: new Date(NOW - 4 * HOUR).toISOString(), reason: "HTTP 429", failures: 5 });
    expect(out.providers[1]!.usage).toMatchObject({ available: true, since: null, reason: null });
  });
});
