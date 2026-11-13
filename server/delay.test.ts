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

function fakePaseo(directory: string) {
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null } }),
    send: async () => undefined,
    reload: async () => undefined,
  });
  const workspace = { id: "ws", projectId: "p", workspaceDirectory: directory };
  return { agents: { ref }, workspaces: { ref: () => ({ refresh: async () => workspace }) } };
}

async function attach(dir: string): Promise<{ store: RunStore; runtime: Runtime }> {
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fakePaseo(dir) as never);
  return { store, runtime };
}

/** A script step that says `again` once, then `done`, looping back to itself after `delay`. */
async function setup(delay: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "delay-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  const log = path.join(dir, "laps.log");
  await writeFile(
    path.join(root, "wait.yaml"),
    `
title: Wait
steps:
  - id: check
    script: { run: lap.sh }
    outcomes: [done, again]
    on: { again: { goto: check, delay: ${delay} } }
`,
  );
  await writeFile(path.join(root, "scripts", "lap.sh"), `#!/bin/sh\ndate +%s%N >> "${log}"\n[ "$(wc -l < "${log}")" -lt 2 ] && echo '{"outcome": "again"}'\nexit 0\n`);
  await chmod(path.join(root, "scripts", "lap.sh"), 0o755);
  const loaded = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "wait")!;
  return { dir, loaded, log, ...(await attach(dir)) };
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const laps = async (log: string) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => Number(line) / 1e6);

describe("goto delay", () => {
  it("loads as delayMs", async () => {
    const { loaded } = await setup("2m");
    expect(loaded.errors).toEqual([]);
    expect(loaded.playbook!.steps[0]!.on.again).toMatchObject({ kind: "goto", target: "check", delayMs: 120_000 });
  });

  it("refuses a bad duration", async () => {
    for (const bad of ["soon", "0s", "2d"]) {
      const { loaded } = await setup(bad);
      expect(loaded.errors.join("\n")).toMatch(/on\.again\.delay: expected a duration/);
    }
  });

  it("holds the target until the delay is over, then runs it", async () => {
    const { loaded, store, runtime, log } = await setup("1s");
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.check!.waitUntil !== null);
    const state = store.get(run.id)!.steps.check!;
    expect(state.status).toBe("pending");
    expect(state.attempts).toHaveLength(1);
    await until(() => store.get(run.id)!.status === "completed");
    const times = await laps(log);
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
    expect(store.get(run.id)!.steps.check!.waitUntil).toBeNull();
  });

  it("resumes after a restart in the middle of the delay", async () => {
    const { loaded, store, runtime, dir, log } = await setup("2s");
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.check!.waitUntil !== null);
    const due = Date.parse(store.get(run.id)!.steps.check!.waitUntil!);
    await runtime.dispose();
    const second = await attach(dir);
    expect(second.store.get(run.id)!.steps.check!.waitUntil).not.toBeNull();
    expect(await laps(log)).toHaveLength(1);
    await until(() => second.store.get(run.id)!.status === "completed");
    expect(Date.now()).toBeGreaterThanOrEqual(due - 50);
    expect(await laps(log)).toHaveLength(2);
  });

  it("does not run the target when the run is canceled during the delay", async () => {
    const { loaded, store, runtime, log } = await setup("1s");
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.check!.waitUntil !== null);
    await runtime.cancelRun(run.id, "no longer needed", null);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(store.get(run.id)!.status).toBe("canceled");
    expect(await laps(log)).toHaveLength(1);
  });
});
