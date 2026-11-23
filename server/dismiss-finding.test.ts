import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunSchema } from "../shared/types";
import { newRun } from "./engine";
import { dismissRefusal, findingSignature, normalizeFindingText, normalizePr } from "./findings";
import { loadPlaybooks } from "./loader";
import { MANAGER_TOOL_NAMES, Runtime, STEP_TOOL_NAMES } from "./runtime";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "dismiss-"));
  temps.push(dir);
  const root = path.join(dir, "repo/.paseo/playbooks");
  await mkdir(path.join(root, "roles/implementer"), { recursive: true });
  await writeFile(path.join(root, "roles/implementer/role.yaml"), "title: Implementer\n");
  await writeFile(path.join(root, "roles/implementer/instructions.md"), "Do it.\n");
  await writeFile(path.join(root, "work.yaml"), "title: Work\nsteps:\n  - id: a\n    role: { name: implementer, agent: { provider: claude, model: m } }\n");
  const entry = (await loadPlaybooks(path.join(dir, "repo"))).entries.find((candidate) => candidate.id === "work")!;
  const store = new RunStore(path.join(dir, "runs"));
  await store.init();
  for (const id of ["r1", "r2"]) await store.create(newRun({ id, playbook: entry.playbook!, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch: null, managerAgentId: "m", inputs: {}, now: new Date(1_700_000_000_000).toISOString() }));
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  const events: unknown[] = [];
  (runtime as unknown as { bus: { onEmit(fn: (event: { type: string; payload: unknown }) => void): void } }).bus.onEmit((event) => void (event.type === "finding.dismissed" && events.push(event.payload)));
  return { store, runtime, events };
}

const finding = { pr: "https://github.com/Acme/App/pull/7", file: "src/a.ts", text: "**P2** Rename `foo` to `bar` (line 42)", severity: "P2", category: "naming", rationale: "The name is used the same way across the module; renaming is churn." };

describe("finding signature", () => {
  it("ignores case, markdown, badges, line numbers, punctuation and path prefixes", () => {
    const a = findingSignature("src/a.ts", "**P2** Rename `foo` to `bar` (line 42)");
    expect(a).toMatch(/^fs1:[0-9a-f]{16}$/);
    expect(findingSignature("./src/a.ts", "![P2 Badge](https://x/y.svg) rename FOO to bar - L97")).toBe(a);
    expect(findingSignature("src\\a.ts", "Rename foo to bar.")).toBe(a);
  });
  it("differs by file and by wording", () => {
    const a = findingSignature("src/a.ts", "Rename foo to bar");
    expect(findingSignature("src/b.ts", "Rename foo to bar")).not.toBe(a);
    expect(findingSignature("src/a.ts", "Rename foo to baz")).not.toBe(a);
  });
  it("normalises text and PR references", () => {
    expect(normalizeFindingText("  Hello,   WORLD!! 12 ")).toBe("hello world");
    expect(normalizePr("https://github.com/Acme/App/pull/7/files")).toBe("acme/app#7");
    expect(normalizePr("Acme/App#7")).toBe("acme/app#7");
    expect(normalizePr("acme/app/pull/7")).toBe("acme/app#7");
  });
});

describe("guardrails", () => {
  it.each([
    ["P1", "naming"],
    ["p0", "naming"],
    ["critical", "naming"],
    ["P2", "security"],
    ["P2", "Auth"],
    ["P2", "authorization bypass"],
    ["P2", "secrets"],
    ["P2", "IAM"],
    ["P2", "db-migration"],
    ["", "naming"],
    ["P2", "  "],
    ["weird", "naming"],
  ])("refuses %s / %s", (severity, category) => {
    expect(dismissRefusal(severity, category)).not.toBeNull();
  });
  it.each([["P2", "naming"], ["low", "style"], ["P3", "test coverage"], ["nit", "docs"]])("allows %s / %s", (severity, category) => {
    expect(dismissRefusal(severity, category)).toBeNull();
  });
});

describe("dismiss_finding", () => {
  it("records on the run, in history, emits the event, and is idempotent", async () => {
    const { store, runtime, events } = await setup();
    const first = await runtime.dismissFinding("r1", finding, "agent a1");
    expect(first.changed).toBe(true);
    expect(first.entry).toMatchObject({ pr: "acme/app#7", file: "src/a.ts", severity: "P2", category: "naming", by: "agent a1", signature: findingSignature("src/a.ts", finding.text) });
    expect(store.get("r1")!.dismissedFindings).toHaveLength(1);
    expect(store.get("r1")!.history.filter((entry) => entry.type === "finding_dismissed")).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "r1", pr: "acme/app#7", rationale: finding.rationale, by: "agent a1" });
    const again = await runtime.dismissFinding("r1", { ...finding, text: "rename foo to bar", file: "./src/a.ts" }, "agent a2");
    expect(again.changed).toBe(false);
    expect(store.get("r1")!.dismissedFindings).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(RunSchema.parse(JSON.parse(JSON.stringify(store.get("r1")))).dismissedFindings).toHaveLength(1);
  });

  it("refuses P1, sensitive categories, missing fields and a short rationale, and records nothing", async () => {
    const { store, runtime, events } = await setup();
    await expect(runtime.dismissFinding("r1", { ...finding, severity: "P1" }, "a")).rejects.toThrow(/human/);
    await expect(runtime.dismissFinding("r1", { ...finding, category: "security" }, "a")).rejects.toThrow(/human/);
    await expect(runtime.dismissFinding("r1", { ...finding, severity: "" }, "a")).rejects.toThrow(/severity is required/);
    await expect(runtime.dismissFinding("r1", { ...finding, category: "" }, "a")).rejects.toThrow(/category is required/);
    await expect(runtime.dismissFinding("r1", { ...finding, rationale: "no" }, "a")).rejects.toThrow(/rationale/);
    await expect(runtime.dismissFinding("nope", finding, "a")).rejects.toThrow(/unknown run/);
    expect(store.get("r1")!.dismissedFindings).toEqual([]);
    expect(events).toEqual([]);
  });

  it("lists a PR's dismissals across runs and checks one finding", async () => {
    const { runtime } = await setup();
    await runtime.dismissFinding("r1", finding, "a");
    await runtime.dismissFinding("r2", { ...finding, file: "src/b.ts", text: "Another thing" }, "b");
    await runtime.dismissFinding("r2", { ...finding, pr: "acme/app#8", text: "Elsewhere" }, "b");
    const list = runtime.dismissedFindings("acme/app#7");
    expect(list.map((entry) => entry.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(runtime.dismissedFindings("acme/app#9")).toEqual([]);
  });

  it("is a manager tool, not a step tool", () => {
    expect(MANAGER_TOOL_NAMES).toContain("dismiss_finding");
    expect(MANAGER_TOOL_NAMES).toContain("list_dismissed_findings");
    expect(STEP_TOOL_NAMES).not.toContain("dismiss_finding");
  });
});
