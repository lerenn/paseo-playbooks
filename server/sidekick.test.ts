import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIDEKICK_WATCH, loadPlaybooks, loadSidekick } from "./loader";
import { Runtime } from "./runtime";
import { SIDEKICK_PROMPT_START } from "../shared/sidekick-marker";
import { SIDEKICK_LABEL, SIDEKICK_PASEO_TOOLS, SIDEKICK_PLUGIN_TOOLS, sidekickPrompt } from "./sidekick";
import { createSidekickStarter } from "./starter";
import { RunStore } from "./store";

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PLAYBOOKS = ".paseo/plugins/playbooks";

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function write(dir: string, rel: string, text: string) {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), text);
}

describe("loading the Sidekick files", () => {
  it("has no Sidekick without a sidekick/ folder", async () => {
    const dir = await tempDir("sk-none-");
    await write(dir, `${PLAYBOOKS}/hello.yaml`, "steps: []\n");
    expect((await loadSidekick(dir)).configured).toBe(false);
  });

  it("reads sidekick.yaml and instructions.md, with the default events to watch", async () => {
    const dir = await tempDir("sk-ok-");
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { model: claude-sonnet-5-5, mode: plan }\n");
    await write(dir, `${PLAYBOOKS}/sidekick/instructions.md`, "  Always ask before touching release.  \n");
    const load = await loadSidekick(dir);
    expect(load).toMatchObject({ configured: true, errors: [], instructions: "Always ask before touching release.", dir: `${PLAYBOOKS}/sidekick` });
    expect(load.config).toEqual({ model: "claude-sonnet-5-5", mode: "plan", watch: DEFAULT_SIDEKICK_WATCH });
  });

  it("accepts a folder with no files, and an explicit watch list", async () => {
    const dir = await tempDir("sk-empty-");
    await mkdir(path.join(dir, PLAYBOOKS, "sidekick"), { recursive: true });
    expect(await loadSidekick(dir)).toMatchObject({ configured: true, errors: [], config: { watch: DEFAULT_SIDEKICK_WATCH } });
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { watch: [gate.*] }\n");
    expect((await loadSidekick(dir)).config?.watch).toEqual(["gate.*"]);
  });

  it("refuses unknown keys, bad YAML and an empty instructions.md", async () => {
    const dir = await tempDir("sk-bad-");
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { modle: plan }\n");
    await write(dir, `${PLAYBOOKS}/sidekick/instructions.md`, "  \n");
    const load = await loadSidekick(dir);
    expect(load.config).toBeNull();
    expect(load.errors.join("\n")).toMatch(/sidekick\.yaml.*modle|Unrecognized key/);
    expect(load.errors.join("\n")).toContain("instructions.md: empty");
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: [unclosed\n");
    expect((await loadSidekick(dir)).errors.join("\n")).toContain("invalid YAML");
  });

  it("coexists with a playbook named sidekick", async () => {
    const dir = await tempDir("sk-coexist-");
    await write(dir, `${PLAYBOOKS}/sidekick.yaml`, "title: Sidekick playbook\nsteps:\n  - id: a\n    gate: { question: ok? }\n");
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { watch: [run.failed] }\n");
    const loaded = await loadPlaybooks(dir);
    expect(loaded.entries.map((entry) => [entry.id, entry.errors])).toEqual([["sidekick", []]]);
    expect(loaded.sidekick).toMatchObject({ configured: true, config: { watch: ["run.failed"] } });
  });

  it("is written by the starter, once, without overwriting", async () => {
    const dir = await tempDir("sk-starter-");
    const files = await createSidekickStarter(dir);
    expect(files).toEqual([`${PLAYBOOKS}/sidekick/sidekick.yaml`, `${PLAYBOOKS}/sidekick/instructions.md`]);
    expect((await loadSidekick(dir)).errors).toEqual([]);
    expect(await readFile(path.join(dir, files[0]!), "utf8")).toContain("sidekick:");
    await expect(createSidekickStarter(dir)).rejects.toThrow(/already has Sidekick files/);
  });
});

describe("the Sidekick prompt", () => {
  it("is scoped to the project, lists what it watches and ends with the repository's instructions", () => {
    const text = sidekickPrompt({ projectId: "p1", label: "Shop", root: "/work/shop", watch: ["gate.escalated"] }, "Never merge on Friday.");
    expect(text).toContain('Sidekick of the project "Shop" (/work/shop)');
    expect(text).toContain("gate.escalated");
    expect(text).toContain('projectId: "p1"');
    expect(text.endsWith("Never merge on Friday.")).toBe(true);
    expect(sidekickPrompt({ projectId: "p1", label: "Shop", root: "/work/shop", watch: [] }, null)).not.toContain("Instructions of this repository");
  });

  it("lets the Sidekick start runs, and has the merging playbook merge", () => {
    const text = sidekickPrompt({ projectId: "p1", label: "Shop", root: "/work/shop", watch: [] }, null);
    expect(text).toContain("start_playbook");
    expect(text).toContain("workspaceId");
    expect(text).toContain("coordinator subagent");
    expect(text).toContain("no access to external systems");
    expect(text).toContain("start the project's merging playbook");
    expect(text).not.toContain("The human merges");
    expect(text).not.toContain("runs are started with a playbook's own manager");
    expect(text).not.toContain("Limit: at most");
    expect(text).not.toContain("ask the human with the interactive question tool and launch");
  });

  it("prints sidekick.runs limits when set", () => {
    const base = { projectId: "p1", label: "Shop", root: "/work/shop", watch: [] };
    expect(sidekickPrompt({ ...base, runs: { maxConcurrent: 3 } }, null)).toContain("at most 3 runs of this project active at once");
    expect(sidekickPrompt({ ...base, runs: { maxConcurrent: 1 } }, null)).toContain("at most 1 run of this project");
    const confirm = sidekickPrompt({ ...base, runs: { confirmBulk: true } }, null);
    expect(confirm).toContain("more than one run in a batch");
    expect(confirm).not.toContain("Limit: at most");
    expect(sidekickPrompt({ ...base, runs: { confirmBulk: false } }, null)).not.toContain("more than one run in a batch (yours");
  });

  it("preapproves start_playbook and list_playbooks", () => {
    expect(SIDEKICK_PLUGIN_TOOLS).toEqual(expect.arrayContaining(["start_playbook", "list_playbooks"]));
    expect(SIDEKICK_PASEO_TOOLS).toEqual(expect.arrayContaining(["list_workspaces", "create_agent"]));
  });

  it("starts with the marker the chat recognises it by and does not ask the agent to rename itself", () => {
    const text = sidekickPrompt({ projectId: "p1", label: "Shop", root: "/work/shop", watch: [] }, null);
    expect(text.startsWith(SIDEKICK_PROMPT_START)).toBe(true);
    expect(text).not.toContain("Name this conversation");
  });
});

function fakePaseo(roots: Record<string, string>) {
  const archivedAt: Record<string, string | null> = {};
  const created = { workspaces: [] as Array<Record<string, unknown>>, agents: [] as Array<{ workspaceId: string; options: Record<string, any> }> };
  const sent: Array<{ agentId: string; text: string }> = [];
  const state: Record<string, { status: string; used: number }> = {};
  const ref = (agentId: string) => ({
    refresh: async () =>
      agentId in archivedAt ? { agent: { id: agentId, status: state[agentId]?.status ?? "idle", archivedAt: archivedAt[agentId], lastUsage: { contextWindowUsedTokens: state[agentId]?.used ?? 0 } } } : null,
    send: async (text: string) => void sent.push({ agentId, text }),
    archive: async () => void (archivedAt[agentId] = new Date().toISOString()),
  });
  const workspace = (id: string) => ({
    id,
    refresh: async () => {
      // "ws-<project>" are the users' workspaces, the others are the hidden ones created below.
      const projectId = id.startsWith("ws-") ? id.slice(3) : id.replace(/^side-/, "");
      const root = roots[projectId];
      return root ? { id, projectId, projectDisplayName: projectId.toUpperCase(), projectRootPath: root, workspaceDirectory: root } : null;
    },
    agents: {
      create: async (options: Record<string, any>) => {
        created.agents.push({ workspaceId: id, options });
        const agentId = `agent-${created.agents.length}`;
        archivedAt[agentId] = null;
        return { id: agentId, ...ref(agentId) };
      },
    },
  });
  const paseo = {
    agents: { ref, list: async () => ({ entries: [] }) },
    workspaces: {
      ref: (id: string) => workspace(id),
      create: async (options: Record<string, any>) => {
        created.workspaces.push(options);
        return workspace(`side-${Object.entries(roots).find(([, root]) => root === options.source.path)![0]}`);
      },
    },
  };
  return { paseo, created, sent, state, archive: (id: string) => (archivedAt[id] = new Date().toISOString()) };
}

async function setup(projects: Record<string, boolean>) {
  const dir = await tempDir("sidekick-");
  const roots: Record<string, string> = {};
  for (const [name, configured] of Object.entries(projects)) {
    roots[name] = path.join(dir, name);
    if (configured) await write(roots[name]!, `${PLAYBOOKS}/sidekick/instructions.md`, `Rules of ${name}.\n`);
    else await mkdir(roots[name]!, { recursive: true });
  }
  const store = new RunStore(path.join(dir, "data", "runs"));
  await store.init();
  const fake = fakePaseo(roots);
  const runtime = new Runtime(store);
  runtimes.push(runtime);
  await runtime.attach(fake.paseo as never);
  return { runtime, store, dir, roots, ...fake };
}

describe("a project's Sidekick", () => {
  it("is created in a hidden background workspace on the project root, with no code tools, subscribed to its project's events", async () => {
    const { runtime, created, roots } = await setup({ shop: true });
    const opened = await runtime.openSidekick("ws-shop");
    expect(opened).toEqual({ projectId: "shop", workspaceId: "side-shop", agentId: "agent-1", created: true });
    expect(created.workspaces[0]).toMatchObject({ background: true, source: { kind: "directory", path: roots.shop } });
    expect(created.workspaces[0]).not.toHaveProperty("internal");
    const { options } = created.agents[0]!;
    expect(options.labels[SIDEKICK_LABEL]).toBe("true");
    expect(options.title).toBe("Playbooks Sidekick · SHOP");
    expect(options.config.options).not.toHaveProperty("disallowedTools");
    expect(options.config.options.allowedTools).toEqual(expect.arrayContaining(["mcp__paseo__create_agent", "mcp__paseo__list_gates"]));
    expect(options.prompt).toContain('Sidekick of the project "SHOP"');
    expect(options.prompt).toContain("Rules of shop.");
    const [subscription] = await runtime.bus.list("agent-1");
    expect(subscription).toMatchObject({ types: DEFAULT_SIDEKICK_WATCH, filter: { projectId: "shop" } });
  });

  it("is reused while alive, shared by concurrent opens, and recreated in the same workspace once archived", async () => {
    const { runtime, created, archive } = await setup({ shop: true });
    const [a, b] = await Promise.all([runtime.openSidekick("ws-shop"), runtime.openSidekick("ws-shop")]);
    expect(b).toEqual(a);
    expect(created.agents).toHaveLength(1);
    expect(await runtime.openSidekick("ws-shop")).toMatchObject({ agentId: "agent-1", created: false });
    archive("agent-1");
    expect(await runtime.openSidekick("ws-shop")).toEqual({ projectId: "shop", workspaceId: "side-shop", agentId: "agent-2", created: true });
    expect(created.workspaces).toHaveLength(1);
  });

  it("restarts on request: the old agent is archived and the new one starts from the saved hand-off", async () => {
    const { runtime, created } = await setup({ shop: true });
    const first = await runtime.openSidekick("ws-shop");
    await runtime.sidekickHandoff(first.agentId, "LEDGER-42", false);
    const next = await runtime.restartSidekick("ws-shop");
    expect(next).toMatchObject({ projectId: "shop", workspaceId: "side-shop", agentId: "agent-2", created: true });
    expect(created.agents[1]!.options.prompt).toContain("LEDGER-42");
    expect(await runtime.openSidekick("ws-shop")).toMatchObject({ agentId: "agent-2", created: false });
    expect(created.workspaces).toHaveLength(1);
  });

  it("is one per project", async () => {
    const { runtime, created } = await setup({ shop: true, blog: true });
    const shop = await runtime.openSidekick("ws-shop");
    const blog = await runtime.openSidekick("ws-blog");
    expect(shop.agentId).not.toBe(blog.agentId);
    expect(created.workspaces).toHaveLength(2);
    expect((await runtime.bus.list(blog.agentId))[0]?.filter).toEqual({ projectId: "blog" });
  });

  it("is refused for a project without sidekick/ files, or with invalid ones", async () => {
    const { runtime, roots } = await setup({ shop: false });
    await expect(runtime.openSidekick("ws-shop")).rejects.toThrow(/has no Sidekick/);
    await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { nope: 1 }\n");
    await expect(runtime.openSidekick("ws-shop")).rejects.toThrow(/have errors/);
  });

  it("is listed per project with its config state and agent", async () => {
    const { runtime } = await setup({ shop: true, blog: false });
    await runtime.openSidekick("ws-shop");
    const projects = await runtime.sidekickProjects([
      { projectId: "shop", workspaceId: "ws-shop" },
      { projectId: "blog", workspaceId: "ws-blog" },
    ]);
    expect(projects).toMatchObject([
      { projectId: "shop", configured: true, agentId: "agent-1", activeRuns: 0 },
      { projectId: "blog", configured: false, agentId: null, activeRuns: 0 },
    ]);
  });
});

describe("a Sidekick's session", () => {
  it("carries the project label, the configured subagent model and the relay and analytics tools", async () => {
    const { runtime, created, roots } = await setup({ shop: true });
    await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { subagents: { provider: codex, model: some-model } }\n");
    await runtime.openSidekick("ws-shop");
    const { options } = created.agents[0]!;
    expect(options.labels).toMatchObject({ [SIDEKICK_LABEL]: "true", "playbooks/project": "shop" });
    expect(options.prompt).toContain("provider codex, model some-model");
    expect(options.config.options.allowedTools).toEqual(expect.arrayContaining(["mcp__paseo__respond_to_permission", "mcp__paseo__get_analytics", "mcp__paseo__sidekick_handoff"]));
  });

  it("starts runs only in a workspace it names, never its own hidden one", async () => {
    const { runtime } = await setup({ shop: true });
    const sidekick = await runtime.openSidekick("ws-shop");
    const caller = { id: sidekick.agentId, workspaceId: sidekick.workspaceId };
    expect(await runtime.isSidekick(sidekick.agentId)).toBe(true);
    expect(await runtime.isSidekick("someone-else")).toBe(false);
    const input = { playbook: "pr", inputs: {}, newWorkspace: false };
    await expect(runtime.startPlaybookInWorkspace(caller, { ...input, workspaceId: undefined })).rejects.toThrow(/pass workspaceId/);
    await expect(runtime.startPlaybookInWorkspace(caller, { ...input, workspaceId: sidekick.workspaceId })).rejects.toThrow(/own hidden workspace/);
  });

  it("reads sidekick.runs, puts it in the prompt, and refuses invalid values", async () => {
    const { runtime, created, roots } = await setup({ shop: true });
    expect((await loadSidekick(roots.shop!)).config?.runs).toBeUndefined();
    await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { runs: { max_concurrent: 2, confirm_bulk: true } }\n");
    expect((await loadSidekick(roots.shop!)).config?.runs).toEqual({ maxConcurrent: 2, confirmBulk: true });
    await runtime.openSidekick("ws-shop");
    expect(created.agents[0]!.options.prompt).toContain("at most 2 runs of this project active at once");
    for (const bad of ["{ max_concurrent: 0 }", "{ max_concurrent: -1 }", "{ max_concurrent: 1.5 }", "{ max_concurrent: lots }", "{ confirm_bulk: yes please }", "{ confirm_bulk: 1 }", "{ other: 1 }", "5"]) {
      await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, `sidekick: { runs: ${bad} }\n`);
      const load = await loadSidekick(roots.shop!);
      expect(load.errors.length, bad).toBeGreaterThan(0);
      expect(load.config).toBeNull();
    }
  });

  it("defaults the subagents to claude / claude-sonnet-5-5 and reads the restart threshold", async () => {
    const { runtime, created, roots } = await setup({ shop: true });
    await runtime.openSidekick("ws-shop");
    expect(created.agents[0]!.options.prompt).toContain("provider claude, model claude-sonnet-5-5");
    await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { session: { restart_above_tokens: 5000 } }\n");
    expect((await loadSidekick(roots.shop!)).config?.restartAboveTokens).toBe(5000);
  });

  it("applies sidekick.subagents.mode to the subagents it creates, and ignores a bad value with a warning", async () => {
    const { runtime, created, roots } = await setup({ shop: true });
    await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { subagents: { mode: acceptEdits } }\n");
    await runtime.openSidekick("ws-shop");
    expect(created.agents[0]!.options.prompt).toContain('settings: { modeId: "acceptEdits" }');
    for (const bad of ["42", "not a mode!", "[plan]"]) {
      await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, `sidekick: { subagents: { mode: ${bad} } }\n`);
      const load = await loadSidekick(roots.shop!);
      expect(load.errors).toEqual([]);
      expect(load.config?.subagents?.mode).toBeUndefined();
      expect(load.warnings[0]).toMatch(/subagents\.mode.*ignored/);
    }
  });

  it("makes subagents inherit sidekick.mode unless subagents.mode is set", async () => {
    const run = async (yaml: string) => {
      const { runtime, created, roots } = await setup({ shop: true });
      await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, yaml);
      await runtime.openSidekick("ws-shop");
      return created.agents[0]!.options.prompt as string;
    };
    expect(await run("sidekick: { mode: bypassPermissions }\n")).toContain('settings: { modeId: "bypassPermissions" }');
    expect(await run("sidekick: { mode: bypassPermissions, subagents: { mode: plan } }\n")).toContain('settings: { modeId: "plan" }');
    expect(await run("sidekick: { model: claude-sonnet-5-5 }\n")).not.toContain("modeId");
  });

  it("is asked to hand off past the context threshold, then restarted with its summary", async () => {
    const { runtime, created, sent, state, roots } = await setup({ shop: true });
    await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { session: { restart_above_tokens: 1000 } }\n");
    await runtime.openSidekick("ws-shop");
    state["agent-1"] = { status: "idle", used: 500 };
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent).toEqual([]);
    state["agent-1"] = { status: "idle", used: 2000 };
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent[0]?.text).toContain("sidekick_handoff");
    await runtime.sidekickHandoff("agent-1", "Ledger: human chose A.", true);
    await runtime.onTurnEnded("agent-1", "completed");
    expect(created.agents).toHaveLength(2);
    expect(created.agents[1]!.options.prompt).toContain("Ledger: human chose A.");
    expect(created.workspaces).toHaveLength(1);
    expect(await runtime.openSidekick("ws-shop")).toMatchObject({ agentId: "agent-2", created: false });
  });

  it("is told at the end of a turn about open gates waiting for a human, once per gate", async () => {
    const { runtime, store, sent } = await setup({ shop: true });
    await runtime.openSidekick("ws-shop");
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent).toEqual([]);
    const gate = (id: string) => ({ id, stepId: "review", status: "pending" }) as never;
    await store.create({ id: "run_a", projectId: "shop", status: "waiting_gate", createdAt: "2026-01-01T00:00:00Z", steps: {}, after: {}, gates: [gate("g1")] } as never);
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("run_a · review (gate g1)");
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent).toHaveLength(1);
    await store.create({ id: "run_b", projectId: "shop", status: "waiting_gate", createdAt: "2026-01-01T00:00:00Z", steps: {}, after: {}, gates: [gate("g2")] } as never);
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("run_b");
    expect(sent[1]?.text).not.toContain("run_a");
  });

  it("restarts from the last saved ledger when it does not hand off, and refuses a hand-off from other agents", async () => {
    const { runtime, created, state } = await setup({ shop: true });
    await runtime.openSidekick("ws-shop");
    await expect(runtime.sidekickHandoff("someone", "x", false)).rejects.toThrow(/only a Sidekick/);
    await runtime.sidekickHandoff("agent-1", "Saved ledger.", false);
    state["agent-1"] = { status: "idle", used: 400_000 };
    await runtime.onTurnEnded("agent-1", "completed");
    await runtime.onTurnEnded("agent-1", "completed");
    expect(created.agents[1]!.options.prompt).toContain("Saved ledger.");
  });

  it("holds a subagent's finish notice while the Sidekick is busy and sends it when it is idle", async () => {
    const { runtime, sent, state } = await setup({ shop: true });
    await runtime.openSidekick("ws-shop");
    state["agent-1"] = { status: "running", used: 0 };
    await runtime.onTurnEnded("sub-1abcdef", "completed", "agent-1");
    expect(sent).toEqual([]);
    state["agent-1"] = { status: "idle", used: 0 };
    await runtime.onTurnEnded("agent-1", "completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("sub-1abc");
    await runtime.onTurnEnded("sub-2xyzabc", "completed", "agent-1");
    expect(sent).toHaveLength(2);
  });
});

describe("needYou", () => {
  it("counts the gates of the project's open runs that wait for a human", async () => {
    const { runtime, store } = await setup({ shop: true });
    const gate = (status: string, decider: unknown = { by: "human" }, escalated: unknown = null) => ({ status, decider, escalated });
    const run = (projectId: string, gates: unknown[], over: Record<string, unknown> = {}) => ({ projectId, status: "running", archivedAt: null, gates, ...over });
    vi.spyOn(store, "list").mockReturnValue([
      run("shop", [gate("pending"), gate("approved"), gate("pending", { by: "role", role: "r" }, null)]),
      run("shop", [gate("pending")], { archivedAt: "2026-01-01" }),
      run("blog", [gate("pending")]),
    ] as never);
    const [shop] = await runtime.sidekickProjects([{ projectId: "shop", workspaceId: "ws-shop" }]);
    expect(shop).toMatchObject({ activeRuns: 1, needYou: 1 });
  });
});

describe("the example Sidekick", () => {
  it("is valid", async () => {
    const examples = path.resolve(__dirname, "..", "examples");
    expect(await loadSidekick(examples)).toMatchObject({ configured: true, errors: [], config: { mode: "plan" } });
  });
});

describe("this repository's own Sidekick", () => {
  it("loads without errors", async () => {
    const repo = path.resolve(__dirname, "..");
    const load = await loadSidekick(repo);
    expect(load).toMatchObject({ configured: true, errors: [], config: { model: "claude-sonnet-5-5", watch: DEFAULT_SIDEKICK_WATCH } });
    expect(load.instructions).toContain("extend-playbook-format");
  });
});
