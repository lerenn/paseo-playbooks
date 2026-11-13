import { chmod, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

/** Just enough of the daemon API: the manager is idle, and every prompt sent is recorded. */
function fakePaseo() {
  const sent: Array<{ agentId: string; text: string }> = [];
  const ref = (agentId: string) => ({
    refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null } }),
    send: async (text: string) => void sent.push({ agentId, text }),
    reload: async () => undefined,
  });
  const workspace = { id: "ws", projectId: "p", workspaceDirectory: null as string | null };
  return { paseo: { agents: { ref }, workspaces: { ref: () => ({ refresh: async () => workspace }) } }, sent, workspace };
}

async function setup(playbook: string, scripts: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "script-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/plugins/playbooks");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "wait.yaml"), playbook);
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(root, "scripts", name), body);
    await chmod(path.join(root, "scripts", name), 0o755);
  }
  const loaded = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "wait")!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  const fake = fakePaseo();
  fake.workspace.workspaceDirectory = dir;
  const runtime = new Runtime(store, { autoStartAgents: false });
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { dir, loaded, store, runtime, ...fake };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const POLLING = `
title: Wait
inputs:
  pr: { type: string }
steps:
  - id: wait_merge
    script: { run: wait.sh, poll: 1s }
    timeout: 1m
    inputs: [pr]
    outputs: { merged_sha: {} }
  - id: deploy
    needs: [wait_merge]
    role: { name: implementer }
    manage: { auto_start: false }
    inputs: [merged_sha]
`;

// Says "not yet" on its first check, then succeeds with an output.
const WAIT_SH = `#!/bin/sh
echo "checking $PLAYBOOK_INPUT_PR (check $PLAYBOOK_CHECK)"
[ "$PLAYBOOK_CHECK" = "1" ] && exit 75
echo '{"summary": "merged", "outputs": {"merged_sha": "abc123"}}'
`;

describe("script steps", () => {
  it("load with their path and poll interval", async () => {
    const { loaded } = await setup(POLLING, { "wait.sh": WAIT_SH });
    expect(loaded.errors).toEqual([]);
    const step = loaded.playbook!.steps.find((candidate) => candidate.id === "wait_merge")!;
    expect(step).toMatchObject({ kind: "script", script: ".paseo/plugins/playbooks/scripts/wait.sh", pollMs: 1000, timeoutMs: 60_000 });
  });

  it("are refused when the script is missing, not executable, a path, or poll is misplaced", async () => {
    const bad = `
title: Wait
steps:
  - id: a
    script: { run: missing.sh }
  - id: b
    script: { run: ../escape.sh }
  - id: c
    script: { run: plain.sh }
  - id: e
    role: { name: implementer }
    poll: 1m
  - id: f
    script: wait.sh
    poll: 1m
  - id: g
    script: { run: wait.sh }
    poll: 1m
`;
    const { dir } = await setup(bad, { "wait.sh": WAIT_SH });
    await writeFile(path.join(dir, ".paseo/plugins/playbooks/scripts/plain.sh"), "#!/bin/sh\n");
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "wait")!;
    const errors = entry.errors.join("\n");
    expect(errors).toMatch(/step "a": script.run: scripts\/missing.sh not found/);
    expect(errors).toMatch(/step "b": script.run: "..\/escape.sh" must be a file name/);
    expect(errors).toMatch(/step "c": script.run: scripts\/plain.sh is not executable/);
    expect(errors).toContain('step "e": `poll` only applies to a script step (under `script:`)');
    expect(errors).toContain('step "f": script: write `script: { run: wait.sh, poll: 1m }`');
    expect(errors).toContain('step "g": `poll` moved under `script:`: write `script: { run: wait.sh, poll: 1m }`');
  });

  it("run by themselves, poll until done, complete, and wake the manager with what is ready", async () => {
    const { loaded, store, runtime, sent } = await setup(POLLING, { "wait.sh": WAIT_SH });
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", { pr: "https://x/pull/7" }, { playbook: loaded.playbook! });
    expect(store.get(run.id)!.steps.wait_merge!.status).toBe("running");
    await expect(runtime.startStep("m", run.id, "wait_merge", "")).rejects.toThrow(/script step: the plugin runs it by itself/);
    await until(() => store.get(run.id)!.steps.wait_merge!.status === "completed");
    const state = store.get(run.id)!.steps.wait_merge!;
    expect(state.outputs).toEqual({ merged_sha: "abc123" });
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]!.checks).toBe(2);
    expect(state.attempts[0]!.lastMessage).toMatch(/checking https:\/\/x\/pull\/7 \(check 2\)/);
    expect(store.get(run.id)!.steps.deploy!.status).toBe("ready");
    await until(() => sent.some((entry) => entry.agentId === "m"));
    const wake = sent.find((entry) => entry.agentId === "m")!.text;
    expect(wake).toMatch(/script step "wait_merge" attempt 1 ended success after 2 check\(s\): merged/);
    expect(wake).toMatch(/do not call complete_step/);
    expect(wake).toMatch(/Ready: deploy/);
    expect(wake).not.toMatch(/starts by itself/);
  });

  it("fail on any other exit code, and retry by themselves", async () => {
    const playbook = `
title: Wait
steps:
  - id: check
    script: { run: fail.sh }
    retries: 1
`;
    const { loaded, store, runtime, sent } = await setup(playbook, { "fail.sh": "#!/bin/sh\necho 'gh: not logged in' >&2\nexit 3\n" });
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.status === "failed");
    // The manager is told just after the run fails, asynchronously.
    await until(() => sent.some((entry) => entry.agentId === "m"));
    const state = store.get(run.id)!.steps.check!;
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[1]!.report).toMatchObject({ outcome: "failure", summary: expect.stringMatching(/exit 3: gh: not logged in/) });
    // Only the final failure reaches the manager: the retry ran by itself.
    expect(sent.filter((entry) => entry.agentId === "m")).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/attempt 2 ended failure/);
    expect(sent[0]!.text).toMatch(/The run is failed/);
  });

  it("time out as a failure", async () => {
    const playbook = `
title: Wait
steps:
  - id: check
    script: { run: never.sh, poll: 1s }
    timeout: 1s
`;
    const { loaded, store, runtime } = await setup(playbook, { "never.sh": "#!/bin/sh\nexit 75\n" });
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.status === "failed");
    const attempt = store.get(run.id)!.steps.check!.attempts[0]!;
    expect(attempt.turnEnd).toBe("timeout");
    expect(attempt.report!.summary).toMatch(/timed out/);
  });

  it("stop when the run is canceled", async () => {
    const playbook = `
title: Wait
steps:
  - id: check
    script: { run: never.sh, poll: 1s }
`;
    const { loaded, store, runtime } = await setup(playbook, { "never.sh": "#!/bin/sh\nexit 75\n" });
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", {}, { playbook: loaded.playbook! });
    await until(() => store.get(run.id)!.steps.check!.attempts[0]!.checks >= 1);
    await runtime.cancelRun(run.id, "no longer needed", null);
    const checks = store.get(run.id)!.steps.check!.attempts[0]!.checks;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(store.get(run.id)!.status).toBe("canceled");
    expect(store.get(run.id)!.steps.check!.attempts[0]!.checks).toBe(checks);
  });
});

describe("script live output", () => {
  const HOLD_SH = `#!/bin/sh
echo "first line"
if [ "$PLAYBOOK_CHECK" = "1" ]; then
  while [ ! -f "$PWD/go" ]; do sleep 0.05; done
  echo "after go"
  exit 75
fi
echo '{"summary": "done", "outputs": {"merged_sha": "abc"}}'
`;

  it("streams the running check's tail, keeps ended checks, and clears at the end", async () => {
    const { loaded, store, runtime, dir } = await setup(POLLING, { "wait.sh": HOLD_SH });
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", { pr: "1" }, { playbook: loaded.playbook! });
    await until(() => runtime.scriptOutput(run.id, "wait_merge").tail.includes("first line"));
    const live = runtime.scriptOutput(run.id, "wait_merge");
    expect(live).toMatchObject({ running: true, checks: [] });
    expect(live.since).not.toBeNull();
    await writeFile(path.join(dir, "go"), "");
    await until(() => runtime.scriptOutput(run.id, "wait_merge").checks.length === 1);
    const between = runtime.scriptOutput(run.id, "wait_merge");
    expect(between.running).toBe(false);
    expect(between.tail).toBe("");
    expect(between.checks[0]).toMatchObject({ n: 1, outcome: "not_yet", exitCode: 75, tail: "first line\nafter go" });
    await until(() => store.get(run.id)!.steps.wait_merge!.status === "completed");
    // The attempt ended: nothing is kept in memory.
    expect(runtime.scriptOutput(run.id, "wait_merge")).toEqual({ running: false, since: null, tail: "", checks: [] });
  });

  it("bounds the tail and the kept checks", async () => {
    const noisy = `#!/bin/sh
i=0
while [ $i -lt 600 ]; do echo "line $i padding padding padding padding padding"; i=$((i+1)); done
[ "$PLAYBOOK_CHECK" -lt 8 ] && exit 75
echo '{"summary": "done", "outputs": {"merged_sha": "abc"}}'
`;
    const fast = POLLING.replace("poll: 1s", "poll: 1s");
    const { loaded, runtime } = await setup(fast, { "wait.sh": noisy });
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "wait", { pr: "1" }, { playbook: loaded.playbook! });
    await until(() => runtime.scriptOutput(run.id, "wait_merge").checks.length >= 2, 10_000);
    const output = runtime.scriptOutput(run.id, "wait_merge");
    expect(output.checks.every((check) => check.tail.length <= 4000)).toBe(true);
    expect(output.checks[0]!.tail).toContain("line 599");
    expect(output.checks.length).toBeLessThanOrEqual(5);
    expect(output.tail.length).toBeLessThanOrEqual(4000);
  });

  it("is empty for a run or step that does not exist", async () => {
    const { runtime } = await setup(POLLING, { "wait.sh": WAIT_SH });
    expect(runtime.scriptOutput("nope", "wait_merge")).toEqual({ running: false, since: null, tail: "", checks: [] });
  });
});
