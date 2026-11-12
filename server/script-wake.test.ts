import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";
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
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null } }),
    send: async () => undefined,
    reload: async () => undefined,
  });
  const workspace = { id: "ws", projectId: "p", workspaceDirectory: dir };
  return { agents: { ref }, workspaces: { ref: () => ({ refresh: async () => workspace }) } };
}

/** Checks log their number and start time; "not yet" until the file `done` exists. `SLOW` makes a check last 300 ms. */
const WAIT_SH = `#!/bin/sh
echo "$PLAYBOOK_CHECK $(date +%s%N)" >> "$PWD/checks.log"
[ -f "$PWD/slow" ] && sleep 0.3
[ -f "$PWD/done" ] && { echo '{"summary": "done", "outputs": {}}'; exit 0; }
exit 75
`;

const playbook = (poll: string, wake: string) => `
title: Wait
steps:
  - id: wait
    script: { run: wait.sh, poll: ${poll}, wake_on: ${wake} }
`;
const JOB_SETTLED = "[{ types: [job.settled], filter: { playbook: other_pipeline, station: production } }]";

async function setup(yaml: string, wakeGapMs = 100) {
  const dir = await mkdtemp(path.join(tmpdir(), "wake-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "wait.yaml"), yaml);
  await writeFile(path.join(root, "scripts/wait.sh"), WAIT_SH);
  await chmod(path.join(root, "scripts/wait.sh"), 0o755);
  const loaded = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "wait")!;
  expect(loaded.errors).toEqual([]);
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const runtime = new Runtime(store, { wakeGapMs });
  runtimes.push(runtime);
  await runtime.attach(fakePaseo(dir) as never);
  const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
  return { dir, store, runtime, run, loaded };
}

const lines = async (dir: string) => (await readFile(path.join(dir, "checks.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => ({ n: Number(line.split(" ")[0]), at: Number(BigInt(line.split(" ")[1]!) / 1_000_000n) }));
const count = async (dir: string) => (await lines(dir)).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

const jobSettled = (over: Record<string, unknown> = {}) => ({ runId: "pipe", playbook: "other_pipeline", runName: null, projectId: "p", workspaceDir: "/", jobId: "job-1", label: "x", station: "production", trainRunId: null, outcome: "success", summary: null, ...over });
const stepCompleted = (runId: string, stepId: string) => ({ runId, playbook: "wait", runName: null, projectId: "p", workspaceDir: "/", stepId, attempt: 1, outcome: "success" });
const wakers = (runtime: Runtime) => (runtime as unknown as { wakers: Map<string, unknown> }).wakers;

describe("script wake_on", () => {
  it("is shown by the wait_for_upstream example", async () => {
    const entry = (await loadPlaybooks(EXAMPLES)).entries.find((candidate) => candidate.id === "wait_for_upstream")!;
    expect(entry.errors).toEqual([]);
    expect(entry.playbook!.steps.find((step) => step.id === "wait_settled")).toMatchObject({ pollMs: 600_000, wakeOn: [{ types: ["job.advanced", "job.settled"], filter: { playbook: "upstream", station: "production" } }] });
  });

  it("runs an idle step's check at once on a matching event, and says why", async () => {
    const { dir, runtime, run } = await setup(playbook("1h", JOB_SETTLED));
    await until(async () => (await count(dir)) === 1);
    await until(() => runtime.scriptOutput(run.id, "wait").checks.length === 1);
    await runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await until(async () => (await count(dir)) === 2);
    await until(() => runtime.scriptOutput(run.id, "wait").checks.length === 2);
    expect(runtime.scriptOutput(run.id, "wait").checks.map((check) => check.trigger)).toEqual(["first", "event:job.settled"]);
  });

  it("ignores events that do not match (type, filter)", async () => {
    const { dir, runtime } = await setup(playbook("1h", JOB_SETTLED));
    await until(async () => (await count(dir)) === 1);
    await runtime.bus.emit("job.settled", jobSettled({ station: "staging" }), { runId: "pipe", source: "pipelines" });
    await runtime.bus.emit("job.settled", jobSettled({ playbook: "else" }), { runId: "pipe", source: "pipelines" });
    await runtime.bus.emit("job.failed", { ...jobSettled(), summary: undefined, reason: null }, { runId: "pipe", source: "pipelines" });
    await sleep(400);
    expect(await count(dir)).toBe(1);
  });

  it("runs one extra check for a burst of events during a running check, never two at once", async () => {
    const { dir, runtime, run } = await setup(playbook("1h", JOB_SETTLED));
    await until(async () => (await count(dir)) === 1);
    await writeFile(path.join(dir, "slow"), "");
    await runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await until(async () => (await count(dir)) === 2);
    // check 2 is running (300 ms): a burst arrives meanwhile
    for (let i = 0; i < 12; i++) await runtime.bus.emit("job.settled", jobSettled({ jobId: `job-${i}` }), { runId: "pipe", source: "pipelines" });
    await until(async () => (await count(dir)) === 3);
    await sleep(900);
    expect(await count(dir)).toBe(3);
    const seen = await lines(dir);
    // not overlapping: each starts after the previous one's 300 ms
    expect(seen[2]!.at - seen[1]!.at).toBeGreaterThanOrEqual(300);
    expect(runtime.scriptOutput(run.id, "wait").checks.map((check) => check.trigger)).toEqual(["first", "event:job.settled", "event:job.settled"]);
  });

  it("keeps the minimum gap between checks", async () => {
    const { dir, store, runtime, run } = await setup(playbook("1h", JOB_SETTLED), 700);
    await until(async () => (await count(dir)) === 1);
    await until(() => runtime.scriptOutput(run.id, "wait").checks.length === 1);
    await runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await sleep(100);
    expect(await count(dir)).toBe(1);
    // the panel's "next check in" follows the wake-up
    const next = Date.parse(store.get(run.id)!.steps.wait!.attempts.at(-1)!.nextCheckAt!);
    expect(next - Date.now()).toBeLessThan(700);
    // more events during the gap change nothing
    await runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await until(async () => (await count(dir)) === 2);
    const seen = await lines(dir);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(650);
    await sleep(400);
    expect(await count(dir)).toBe(2);
  });

  it("still polls without events", async () => {
    const { dir, runtime, run } = await setup(playbook("1s", JOB_SETTLED));
    await until(async () => (await count(dir)) === 2, 6000);
    await until(() => runtime.scriptOutput(run.id, "wait").checks.length === 2);
    expect(runtime.scriptOutput(run.id, "wait").checks.map((check) => check.trigger)).toEqual(["first", "poll"]);
  });

  it("is not woken by events about its own step, but is by the same type from another step or run", async () => {
    const { dir, runtime, run } = await setup(playbook("1h", "[{ types: [step.completed] }]"));
    await until(async () => (await count(dir)) === 1);
    await runtime.bus.emit("step.completed", stepCompleted(run.id, "wait"), { runId: run.id, source: "runs" });
    await sleep(300);
    expect(await count(dir)).toBe(1);
    await runtime.bus.emit("step.completed", stepCompleted("other-run", "wait"), { runId: "other-run", source: "runs" });
    await until(async () => (await count(dir)) === 2);
  });

  it("listens on globs", async () => {
    const { dir, runtime } = await setup(playbook("1h", "[{ types: ['job.*'] }]"));
    await until(async () => (await count(dir)) === 1);
    await runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await until(async () => (await count(dir)) === 2);
  });

  it("drops its listener when the step ends, and when the run is canceled", async () => {
    const first = await setup(playbook("1h", JOB_SETTLED));
    await until(async () => (await count(first.dir)) === 1);
    expect(wakers(first.runtime).size).toBe(1);
    await writeFile(path.join(first.dir, "done"), "");
    await first.runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await until(() => first.store.get(first.run.id)!.steps.wait!.status === "completed");
    expect(wakers(first.runtime).size).toBe(0);

    const second = await setup(playbook("1h", JOB_SETTLED));
    await until(async () => (await count(second.dir)) === 1);
    expect(wakers(second.runtime).size).toBe(1);
    await second.runtime.cancelRun(second.run.id, "test", null);
    await second.runtime.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await sleep(200);
    expect(wakers(second.runtime).size).toBe(0);
    expect(await count(second.dir)).toBe(1);
  });

  it("registers its listener again after a daemon restart", async () => {
    const { dir, run, runtime } = await setup(playbook("1h", JOB_SETTLED));
    await until(async () => (await count(dir)) === 1);
    await runtime.dispose();
    const store = new RunStore(path.join(dir, "runs"));
    await store.init();
    expect(store.get(run.id)!.steps.wait!.status).toBe("running");
    const again = new Runtime(store, { wakeGapMs: 100 });
    runtimes.push(again);
    await again.attach(fakePaseo(dir) as never);
    // the check cut by the restart runs again
    await until(async () => (await count(dir)) === 2);
    expect(wakers(again).size).toBe(1);
    await sleep(150);
    await again.bus.emit("job.settled", jobSettled(), { runId: "pipe", source: "pipelines" });
    await until(async () => (await count(dir)) === 3);
  });

  it("matches many listeners quickly", async () => {
    const { runtime } = await setup(playbook("1h", JOB_SETTLED));
    const map = wakers(runtime) as Map<string, unknown>;
    for (let i = 0; i < 2000; i++) map.set(`fake-${i}`, { runId: `r${i}`, stepId: "s", rules: [{ types: [/^job\.settled$/], filter: [["station", `st-${i}`]] }], busy: false, dirty: null, gapWait: false, endedAt: 0 });
    const started = performance.now();
    for (let i = 0; i < 500; i++) await runtime.bus.emit("job.settled", jobSettled({ station: "none" }), { runId: "pipe", source: "pipelines" });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(map.size).toBe(2001);
  });
});
