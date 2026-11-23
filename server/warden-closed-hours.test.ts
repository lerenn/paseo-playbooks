import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { parseClosedHours } from "./config";
import { gateOpenCandidates, heldCandidates, slowCandidates, stalledCandidates, stalledInfo, staleDefinitionCandidate } from "./warden";
import { prCandidates } from "./warden-prs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => Date.parse(iso);
/** Closed every day from 00:00 to 08:00 UTC. */
const NIGHT = parseClosedHours({ timezone: "UTC", slots: [{ days: "everyday", from: "00:00", to: "08:00" }] })!;
const PARIS_NIGHT = parseClosedHours({ timezone: "Europe/Paris", slots: [{ days: "everyday", from: "00:00", to: "08:00" }] })!;

const stalledRun = (idleAt: string) => ({ status: "running", pausedAt: null, playbook: { singleton: false }, batch: null, steps: {}, gates: [], rateHold: null, history: [], createdAt: idleAt, loops: {}, after: {} }) as unknown as Run;

describe("warden: closed hours pause the time thresholds", () => {
  it("stalled: time spent closed does not count, and the clock resumes when the slot ends", () => {
    const info = { idleSince: at("2026-11-18T07:30:00Z"), last: "x", steps: "none" };
    const check = (now: string, closed: typeof NIGHT | null) => stalledCandidates({} as Run, info, HOUR, at(now), "idle", false, "report", closed);
    // Plain: 1h at 08:30. With the night closed only 30 open minutes have passed.
    expect(check("2026-11-18T08:30:00Z", null)).toHaveLength(1);
    expect(check("2026-11-18T08:30:00Z", NIGHT)).toEqual([]);
    // The slot ended at 08:00; the hour is complete at 09:00.
    expect(check("2026-11-18T08:59:00Z", NIGHT)).toEqual([]);
    const [found] = check("2026-11-18T09:00:00Z", NIGHT);
    expect(found!.value).toBe(60);
  });

  it("stalled: nothing fires while a slot is closed, however long the run was idle before it", () => {
    const info = { idleSince: at("2026-11-17T23:00:00Z"), last: "x", steps: "none" };
    // 1h open (23:00-00:00), then closed until 08:00: it fires at midnight (threshold 1h reached), and cannot grow before 08:00.
    const closedNow = stalledCandidates({} as Run, info, 2 * HOUR, at("2026-11-18T07:00:00Z"), "idle", false, "report", NIGHT);
    expect(closedNow).toEqual([]);
    expect(stalledCandidates({} as Run, info, 2 * HOUR, at("2026-11-18T09:00:00Z"), "idle", false, "report", NIGHT)).toHaveLength(1);
  });

  it("follows daylight saving time: the 9 hour closed night of the clock change is not counted", () => {
    // Paris night 00:00-08:00 local, 2026-10-25 (clocks go back): 22:00Z to 07:00Z.
    const info = { idleSince: at("2026-10-24T21:00:00Z"), last: "x", steps: "none" };
    const check = (now: string) => stalledCandidates({} as Run, info, 3 * HOUR, at(now), "idle", false, "report", PARIS_NIGHT);
    expect(check("2026-10-25T08:00:00Z")).toEqual([]); // 1h before 22:00Z + 1h after 07:00Z = 2h open
    expect(check("2026-10-25T09:00:00Z")).toHaveLength(1);
  });

  it("held: the hold age counts open time only", () => {
    const run = { status: "running", pausedAt: null, rateHold: { since: "2026-11-18T07:00:00Z", kind: "headroom", reason: "r", provider: "claude", window: "weekly", retryAt: null, position: null, priority: null, estimatedCost: null, headroom: null } } as unknown as Run;
    const check = (now: string, closed: typeof NIGHT | null) => heldCandidates(run, [run], 2 * HOUR, at(now), "report", closed);
    expect(check("2026-11-18T09:30:00Z", null)).toHaveLength(1);
    expect(check("2026-11-18T09:30:00Z", NIGHT)).toEqual([]);
    expect(check("2026-11-18T10:00:00Z", NIGHT)).toHaveLength(1);
  });

  it("gate_open: the gate's age counts open time only", () => {
    const run = { id: "r", playbook: { id: "p", steps: [], after: [] }, gates: [{ id: "g1", status: "pending", kind: "question", message: "q", stepId: "s", requestedAt: "2026-11-18T07:00:00Z", escalated: null, deferral: null, by: "manager" }], history: [], steps: {} } as unknown as Run;
    const check = (now: string, closed: typeof NIGHT | null) => gateOpenCandidates(run, 2 * HOUR, at(now), "report", closed);
    expect(check("2026-11-18T09:00:00Z", null)).toHaveLength(1);
    expect(check("2026-11-18T09:00:00Z", NIGHT)).toEqual([]);
    expect(check("2026-11-18T10:00:00Z", NIGHT)).toHaveLength(1);
  });

  it("stale_definition: the run's age counts open time only", () => {
    const run = { status: "running", createdAt: "2026-11-18T07:00:00Z", history: [], rateHold: null, gates: [], steps: { a: { status: "running" } }, afterTasks: {}, definition: { source: "origin", sha: "aaa", ref: "origin/main" } } as unknown as Run;
    const check = (now: string, closed: typeof NIGHT | null) => staleDefinitionCandidate(run, "bbb", 2 * HOUR, at(now), "report", closed);
    expect(check("2026-11-18T09:00:00Z", null)).toHaveLength(1);
    expect(check("2026-11-18T09:00:00Z", NIGHT)).toEqual([]);
    expect(check("2026-11-18T10:00:00Z", NIGHT)).toHaveLength(1);
  });

  it("slow: a step is slow by its open time, so a slot closed does not make it slow", () => {
    const started = "2026-11-18T06:00:00Z";
    const run = { playbook: { slowWarning: { runs: 5, factor: 2 } }, steps: { s: { status: "running", attempts: [{ startedAt: started }] } } } as unknown as Run;
    const info = (now: string) => ({ s: { elapsedMs: at(now) - at(started), baselineMs: HOUR, ratio: (at(now) - at(started)) / HOUR, samples: 5 } });
    const now = "2026-11-18T08:30:00Z"; // 2.5h elapsed (ratio 2.5), but only 30 open minutes
    expect(slowCandidates(run, info(now), "report", at(now), null)).toHaveLength(1);
    expect(slowCandidates(run, info(now), "report", at(now), NIGHT)).toEqual([]);
    const later = "2026-11-18T10:30:00Z"; // 2.5h open
    expect(slowCandidates(run, info(later), "report", at(later), NIGHT)).toHaveLength(1);
  });

  it("no closed hours: nothing changes", () => {
    const info = { idleSince: at("2026-11-18T07:30:00Z"), last: "x", steps: "none" };
    expect(stalledCandidates({} as Run, info, HOUR, at("2026-11-18T08:30:00Z"), "idle", false, "report")).toHaveLength(1);
    expect(stalledInfo(stalledRun("2026-11-18T07:30:00Z"))).not.toBeNull();
  });

  it("PR checks: a draft's idle time counts open time only", () => {
    const pr = { number: 1, url: "u", repo: "", isDraft: true, updatedAt: "2026-11-18T07:00:00Z", reviews: [], comments: [], requested: [], checks: [], headSha: "x", headRefName: "b", baseRefName: "main", headCommittedAt: null, mergeable: "MERGEABLE", title: "t", author: "a" };
    const config = { draftIdle: { afterMs: 2 * HOUR } } as never;
    const run = (now: string, closed: typeof NIGHT | null) => prCandidates([pr as never], [], config, at(now), new Map(), closed);
    expect(run("2026-11-18T09:00:00Z", null)).toHaveLength(1);
    expect(run("2026-11-18T09:00:00Z", NIGHT)).toEqual([]);
    expect(run("2026-11-18T10:00:00Z", NIGHT)).toHaveLength(1);
  });
});
