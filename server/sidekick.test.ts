import { z } from "zod";
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

describe("profile Sidekick tiers", () => {
  const defaults = `tiers:
  worker:
    - { provider: claude, model: primary, mode: bypassPermissions }
    - { provider: codex, model: backup, mode: full-access }
providers: { usage: { check: false }, exhausted_for: 2h }
agent_rules: ["Keep changes focused."]
`;

  it("uses only active profiles, alphabetically, ahead of the legacy folder and loads profile rules", async () => {
    const dir = await tempDir("sk-profiles-");
    await write(dir, `${PLAYBOOKS}/sidekick/instructions.md`, "Legacy.");
    for (const id of ["alice", "bob"]) {
      await write(dir, `${PLAYBOOKS}/profiles/${id}/defaults/main.yaml`, defaults);
      await write(dir, `${PLAYBOOKS}/profiles/${id}/sidekick/sidekick.yaml`, "sidekick: { tier: worker, subagents: { tier: worker } }");
    }
    expect((await loadSidekick(dir)).profile).toBeNull();
    const load = await loadSidekick(dir, { activeProfiles: ["bob", "alice"] });
    expect(load).toMatchObject({ profile: "alice", errors: [], config: {
      tier: "worker", provider: "claude", model: "primary", mode: "bypassPermissions",
      fallback: [{ provider: "codex", model: "backup", mode: "full-access" }],
      subagents: { tier: "worker", provider: "claude", model: "primary", fallback: [{ provider: "codex", model: "backup", mode: "full-access" }] },
      providers: { usageCheck: false, exhaustedForMs: 7200000 }, agentRules: ["Keep changes focused."],
    } });
    expect(load.warnings.join("\n")).toContain("bob");
    expect(load.warnings.join("\n")).toContain("ignored");
    expect((await loadPlaybooks(dir, { activeProfiles: ["bob"] })).sidekick.profile).toBe("bob");
  });

  it("resolves top-level tiers and rejects unknown tiers, conflicts and misplaced tier fields", async () => {
    const dir = await tempDir("sk-tier-errors-");
    await write(dir, `${PLAYBOOKS}/defaults/main.yaml`, defaults);
    for (const yaml of ["sidekick: { tier: absent }", "sidekick: { tier: worker, model: override }", "sidekick: { subagents: { tier: worker, mode: plan } }", "tier: worker", "sidekick: { session: { tier: worker } }"]) {
      await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, yaml);
      expect((await loadSidekick(dir)).errors.length, yaml).toBeGreaterThan(0);
    }
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { tier: worker }");
    expect(await loadSidekick(dir)).toMatchObject({ errors: [], profile: null, config: { model: "primary" } });
    await write(dir, `${PLAYBOOKS}/defaults/main.yaml`, "tiers: { worker: { provider: codex, model: small } }");
    await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { tier: worker, model: large }");
    expect(await loadSidekick(dir)).toMatchObject({ errors: [], config: { provider: "codex", model: "large" } });
  });

  it("applies defaults even with no sidekick.yaml and reports invalid profile defaults", async () => {
    const dir = await tempDir("sk-profile-defaults-");
    await write(dir, `${PLAYBOOKS}/profiles/alice/sidekick/instructions.md`, "Rules.");
    await write(dir, `${PLAYBOOKS}/profiles/alice/defaults/main.yaml`, defaults);
    expect(await loadSidekick(dir, { activeProfiles: ["alice"] })).toMatchObject({ errors: [], config: { agentRules: ["Keep changes focused."] } });
    await write(dir, `${PLAYBOOKS}/profiles/alice/defaults/main.yaml`, "providers: { exhausted_for: invalid }");
    expect((await loadSidekick(dir, { activeProfiles: ["alice"] })).config).toBeNull();
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
  const targets: Record<string, { provider: string; model: string }> = {};
  const timeline: Record<string, any[]> = {};
  const usageData: { providers: any[] } = { providers: [] };
  const created = { workspaces: [] as Array<Record<string, unknown>>, agents: [] as Array<{ workspaceId: string; options: Record<string, any> }> };
  const sent: Array<{ agentId: string; text: string }> = [];
  const state: Record<string, { status: string; used: number }> = {};
  const latency = { ms: 0 };
  const labels: Record<string, Record<string, string>> = {};
  const failSend = { on: false };
  const live = { count: 0, max: 0 };
  const ref = (agentId: string) => ({
    refresh: async () =>
      (latency.ms ? await new Promise((done) => setTimeout(done, latency.ms)) : undefined, agentId in archivedAt ? { agent: { id: agentId, ...targets[agentId], status: state[agentId]?.status ?? "idle", archivedAt: archivedAt[agentId], lastUsage: { contextWindowUsedTokens: state[agentId]?.used ?? 0 } } } : null),
    timeline: { refetch: async () => ({ entries: timeline[agentId] ?? [] }) },
    send: async (text: string) => {
      if (failSend.on) throw new Error("no compaction here");
      sent.push({ agentId, text });
    },
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
        const [provider, ...model] = options.config.provider.split("/");
        targets[agentId] = { provider, model: model.join("/") };
        labels[agentId] = options.labels;
        // A Sidekick never starts while another one of the project is alive.
        live.count = Object.keys(labels).filter((id) => archivedAt[id] === null).length;
        live.max = Math.max(live.max, live.count);
        return { id: agentId, ...ref(agentId) };
      },
    },
  });
  const paseo = {
    providers: { listUsage: async () => usageData },
    agents: { ref, list: async () => ({ entries: Object.keys(labels).map((id) => ({ agent: { id, labels: labels[id], archivedAt: archivedAt[id], createdAt: `2026-01-01T00:00:${String(id.replace(/\D/g, "") || 0).padStart(2, "0")}Z` } })) }) },
    workspaces: {
      ref: (id: string) => workspace(id),
      create: async (options: Record<string, any>) => {
        created.workspaces.push(options);
        return workspace(`side-${Object.entries(roots).find(([, root]) => root === options.source.path)![0]}`);
      },
    },
  };
  return { paseo, created, sent, state, timeline, usageData, latency, labels, failSend, live, archivedAt, archive: (id: string) => (archivedAt[id] = new Date().toISOString()) };
}

async function setup(projects: Record<string, boolean>, options: { debounceMs?: number } = {}) {
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
  const runtime = new Runtime(store, options);
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

describe("the Sidekick column's list", () => {
  it("asks the projects at once, not one after the other, and keeps the input's order", async () => {
    const names = Array.from({ length: 30 }, (_, index) => `p${index}`);
    const { runtime, latency } = await setup(Object.fromEntries(names.map((name) => [name, true])));
    for (const name of names) await runtime.openSidekick(`ws-${name}`);
    latency.ms = 20;
    const started = performance.now();
    const projects = await runtime.sidekickProjects(names.map((name) => ({ projectId: name, workspaceId: `ws-${name}` })));
    const took = performance.now() - started;
    console.log(`[bench] sidekickProjects, 30 projects, 20 ms per agent lookup: ${took.toFixed(0)} ms`);
    expect(projects.map((project) => project.projectId)).toEqual(names);
    expect(projects.every((project) => project.agentId !== null)).toBe(true);
    // One after the other would take 30 x 20 ms.
    expect(took).toBeLessThan(300);
  });

  it("leaves out a project whose workspace is gone", async () => {
    const { runtime } = await setup({ shop: true });
    const projects = await runtime.sidekickProjects([
      { projectId: "gone", workspaceId: "ws-gone" },
      { projectId: "shop", workspaceId: "ws-shop" },
    ]);
    expect(projects.map((project) => project.projectId)).toEqual(["shop"]);
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

  it("never runs in an existing workspace, and needs no workspace of its own: it branches off its project root", async () => {
    const { runtime } = await setup({ shop: true });
    const sidekick = await runtime.openSidekick("ws-shop");
    const caller = { id: sidekick.agentId, workspaceId: sidekick.workspaceId };
    expect(await runtime.isSidekick(sidekick.agentId)).toBe(true);
    expect(await runtime.isSidekick("someone-else")).toBe(false);
    await expect(runtime.startPlaybookInWorkspace(caller, { playbook: "pr", inputs: {}, newWorkspace: false, workspaceId: "ws-shop" })).rejects.toThrow(/no `isolation: { mode: worktree }`/);
    // No workspaceId: the base is its own workspace, so it is not refused for a missing one.
    await expect(runtime.startPlaybookInWorkspace(caller, { playbook: "pr", inputs: {}, newWorkspace: true, workspaceId: undefined })).rejects.not.toThrow(/workspaceId is missing|own hidden/);
    await expect(runtime.startPlaybookInWorkspace({ id: "x", workspaceId: null }, { playbook: "pr", inputs: {}, newWorkspace: true, workspaceId: undefined })).rejects.toThrow(/workspaceId is missing/);
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

  describe("tier failover", () => {
    const configure = async () => {
      const made = await setup({ shop: true });
      await write(made.roots.shop!, `${PLAYBOOKS}/defaults/main.yaml`, `tiers:
  worker:
    - { provider: claude, model: first, mode: bypassPermissions }
    - { provider: codex, model: second, mode: full-access }
    - { provider: backup, model: third, mode: default }
providers: { usage: { check: false }, exhausted_for: 2h }
`);
      await write(made.roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { tier: worker, subagents: { tier: worker } }");
      await made.runtime.openSidekick("ws-shop");
      await made.runtime.sidekickHandoff("agent-1", "Continue task 42.", false);
      return made;
    };

    it("moves through the ordered chain on quota failures, preserves the ledger, and keeps the target on restart", async () => {
      const { runtime, created, timeline, live } = await configure();
      timeline["agent-1"] = [{ item: { type: "error", message: "out of tokens" } }];
      await runtime.onTurnEnded("agent-1", "failed");
      expect(created.agents[1]!.options.config).toMatchObject({ provider: "codex/second", modeId: "full-access" });
      expect(created.agents[1]!.options.prompt).toContain("Continue task 42.");
      expect(created.agents[1]!.options.prompt).toContain("provider codex, model second");
      expect(created.agents[1]!.options.prompt).toContain("backup/third");
      await runtime.restartSidekick("ws-shop");
      expect(created.agents[2]!.options.config.provider).toBe("codex/second");
      timeline["agent-3"] = [{ item: { type: "assistant_message", text: "You've hit your weekly limit" } }];
      await runtime.onTurnEnded("agent-3", "completed");
      expect(created.agents[3]!.options.config.provider).toBe("backup/third");
      timeline["agent-4"] = [{ item: { type: "error", message: "out of credits" } }];
      await runtime.onTurnEnded("agent-4", "failed");
      expect(created.agents).toHaveLength(4);
      expect(live.max).toBe(1);
    });

    it("skips usage-blocked targets at launch and compaction replacement, then uses providers.fallback", async () => {
      const { runtime, roots, created, usageData, failSend, state } = await setup({ shop: true });
      await write(roots.shop!, `${PLAYBOOKS}/defaults/main.yaml`, `tiers:
  worker:
    - { provider: claude, model: first, mode: bypassPermissions }
    - { provider: codex, model: second, mode: full-access }
providers: { fallback: [backup/third], usage: { threshold: 90 } }
`);
      await write(roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { tier: worker, session: { compact_above_tokens: 1000 } }");
      usageData.providers = [
        { providerId: "claude", status: "available", windows: [{ id: "weekly", usedPct: 95 }] },
        { providerId: "codex", status: "available", windows: [{ id: "weekly", usedPct: 100 }] },
      ];
      await runtime.openSidekick("ws-shop");
      expect(created.agents[0]!.options.config).toEqual({ provider: "backup/third" });
      await runtime.sidekickHandoff("agent-1", "Keep this through compaction failure.", false);
      state["agent-1"] = { status: "idle", used: 2000 };
      failSend.on = true;
      await runtime.onTurnEnded("agent-1", "completed");
      expect(created.agents[1]!.options.config).toEqual({ provider: "backup/third" });
      expect(created.agents[1]!.options.prompt).toContain("Keep this through compaction failure.");
    });

    it("fails over when compaction ends on quota instead of retrying the exhausted provider", async () => {
      const { runtime, created, timeline } = await configure();
      await runtime.sidekickHandoff("agent-1", "Ledger during compaction.", true);
      await runtime.onTurnEnded("agent-1", "completed");
      timeline["agent-1"] = [{ item: { type: "error", message: "out of tokens" } }];
      await runtime.onTurnEnded("agent-1", "failed");
      expect(created.agents[1]!.options.config.provider).toBe("codex/second");
      expect(created.agents[1]!.options.prompt).toContain("Ledger during compaction.");
    });

    it("does not fail over on other errors or cancelled turns", async () => {
      const { runtime, created, timeline } = await configure();
      timeline["agent-1"] = [{ item: { type: "error", message: "connection closed" } }];
      await runtime.onTurnEnded("agent-1", "failed");
      timeline["agent-1"] = [{ item: { type: "error", message: "out of tokens" } }];
      await runtime.onTurnEnded("agent-1", "canceled");
      expect(created.agents).toHaveLength(1);
    });
  });

  describe("context compaction", () => {
    const COMPACT = "sidekick: { session: { compact_above_tokens: 1000, hard_limit_tokens: 3000 } }\n";
    const compactSetup = async (yaml = COMPACT) => {
      const made = await setup({ shop: true });
      await write(made.roots.shop!, `${PLAYBOOKS}/sidekick/sidekick.yaml`, yaml);
      await made.runtime.openSidekick("ws-shop");
      return made;
    };

    it("compacts the same agent, idle and above the threshold, with the saved ledger in the instructions", async () => {
      const { runtime, created, sent, state } = await compactSetup();
      await runtime.sidekickHandoff("agent-1", "Ledger: human chose A.", false);
      state["agent-1"] = { status: "idle", used: 500 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent).toEqual([]);
      state["agent-1"] = { status: "idle", used: 2000 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text.startsWith("/compact ")).toBe(true);
      expect(sent[0]!.text).toContain("Ledger: human chose A.");
      expect(created.agents).toHaveLength(1);
      expect(await runtime.openSidekick("ws-shop")).toMatchObject({ agentId: "agent-1", created: false });
    });

    it("never compacts mid-turn: a failed or canceled turn does not trigger it", async () => {
      const { runtime, sent, state } = await compactSetup();
      state["agent-1"] = { status: "idle", used: 2000 };
      await runtime.onTurnEnded("agent-1", "canceled");
      await runtime.onTurnEnded("agent-1", "failed");
      expect(sent).toEqual([]);
    });

    it("re-injects the ledger once the compaction ended, with the notices held meanwhile, and says it is compacting", async () => {
      const { runtime, sent, state } = await compactSetup();
      await runtime.sidekickHandoff("agent-1", "LEDGER-7", false);
      state["agent-1"] = { status: "idle", used: 2000 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(await runtime.sidekickProjects([{ projectId: "shop", workspaceId: "ws-shop" }])).toMatchObject([{ agentId: "agent-1", compacting: true }]);
      state["agent-1"] = { status: "running", used: 0 };
      await runtime.onTurnEnded("sub-1abcdef", "completed", "agent-1");
      expect(sent).toHaveLength(1);
      state["agent-1"] = { status: "idle", used: 0 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent).toHaveLength(2);
      expect(sent[1]!.text).toContain("Context compacted");
      expect(sent[1]!.text).toContain("LEDGER-7");
      expect(sent[1]!.text).toContain("sub-1abc");
      expect(await runtime.sidekickProjects([{ projectId: "shop", workspaceId: "ws-shop" }])).toMatchObject([{ compacting: false }]);
    });

    it("compacts when the Sidekick asks with sidekick_handoff restart, and does not compact again until it grew well past what was left", async () => {
      const { runtime, sent, state } = await compactSetup();
      await runtime.sidekickHandoff("agent-1", "L", true);
      state["agent-1"] = { status: "idle", used: 10 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent[0]!.text).toMatch(/^\/compact /);
      state["agent-1"] = { status: "idle", used: 1500 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent).toHaveLength(2);
      for (const used of [1600, 1800]) {
        state["agent-1"] = { status: "idle", used };
        await runtime.onTurnEnded("agent-1", "completed");
      }
      expect(sent.filter((message) => message.text.startsWith("/compact"))).toHaveLength(1);
      state["agent-1"] = { status: "idle", used: 2500 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent.filter((message) => message.text.startsWith("/compact"))).toHaveLength(2);
    });

    it("falls back to a safe replacement when the compaction cannot be sent: the old agent is archived before the new one is created", async () => {
      const { runtime, created, state, failSend, archivedAt, live } = await compactSetup();
      await runtime.sidekickHandoff("agent-1", "LEDGER-9", false);
      failSend.on = true;
      state["agent-1"] = { status: "idle", used: 2000 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(created.agents).toHaveLength(2);
      expect(created.agents[1]!.options.prompt).toContain("LEDGER-9");
      expect(archivedAt["agent-1"]).toBeTruthy();
      expect(live.max).toBe(1);
      expect(created.workspaces).toHaveLength(1);
    });

    it("falls back to a safe replacement when the compaction fails, or leaves the context above the hard limit", async () => {
      for (const after of [{ outcome: "failed" as const, used: 0 }, { outcome: "completed" as const, used: 3500 }]) {
        const { runtime, created, state, live, archivedAt } = await compactSetup();
        state["agent-1"] = { status: "idle", used: 2000 };
        await runtime.onTurnEnded("agent-1", "completed");
        expect(created.agents).toHaveLength(1);
        state["agent-1"] = { status: "idle", used: after.used };
        await runtime.onTurnEnded("agent-1", after.outcome);
        expect(created.agents).toHaveLength(2);
        expect(archivedAt["agent-1"]).toBeTruthy();
        expect(live.max).toBe(1);
      }
    });

    it("reads the thresholds: compact_above_tokens, its older name restart_above_tokens, the default, and a hard limit of 1.5x", async () => {
      const { sidekickLimits } = await import("./sidekick");
      expect(sidekickLimits(null)).toEqual({ compact: 300_000, hard: 450_000 });
      expect(sidekickLimits({ restartAboveTokens: 1000 })).toEqual({ compact: 1000, hard: 1500 });
      expect(sidekickLimits({ restartAboveTokens: 1000, compactAboveTokens: 2000 })).toEqual({ compact: 2000, hard: 3000 });
      expect(sidekickLimits({ compactAboveTokens: 2000, hardLimitTokens: 500 })).toEqual({ compact: 2000, hard: 2000 });
      const dir = await tempDir("sk-limits-");
      await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { session: { restart_above_tokens: 5000 } }\n");
      const old = await loadSidekick(dir);
      expect(old).toMatchObject({ errors: [], warnings: [], config: { restartAboveTokens: 5000 } });
      await write(dir, `${PLAYBOOKS}/sidekick/sidekick.yaml`, "sidekick: { session: { compact_above_tokens: 5000, hard_limit_tokens: 9000 } }\n");
      expect((await loadSidekick(dir)).config).toMatchObject({ compactAboveTokens: 5000, hardLimitTokens: 9000 });
    });

    it("compacts at the old restart_above_tokens threshold of an existing config", async () => {
      const { runtime, created, sent, state } = await compactSetup("sidekick: { session: { restart_above_tokens: 1000 } }\n");
      state["agent-1"] = { status: "idle", used: 1200 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(sent[0]!.text).toMatch(/^\/compact /);
      expect(created.agents).toHaveLength(1);
    });
  });

  describe("at most one live Sidekick per project", () => {
    it("holds when a restart, a replacement and opens run at the same time", async () => {
      const { runtime, created, live, state, failSend, archivedAt } = await setup({ shop: true });
      await runtime.openSidekick("ws-shop");
      failSend.on = true;
      state["agent-1"] = { status: "idle", used: 400_000 };
      await Promise.all([runtime.onTurnEnded("agent-1", "completed"), runtime.restartSidekick("ws-shop"), runtime.openSidekick("ws-shop"), runtime.openSidekick("ws-shop")]);
      expect(live.max).toBe(1);
      expect(Object.values(archivedAt).filter((value) => value === null)).toHaveLength(1);
      expect(created.workspaces).toHaveLength(1);
    });

    it("does not replace an agent twice for two concurrent triggers", async () => {
      const { runtime, created, state, failSend, live } = await setup({ shop: true });
      await runtime.openSidekick("ws-shop");
      failSend.on = true;
      state["agent-1"] = { status: "idle", used: 400_000 };
      await Promise.all([runtime.onTurnEnded("agent-1", "completed"), runtime.onTurnEnded("agent-1", "completed")]);
      expect(created.agents).toHaveLength(2);
      expect(live.max).toBe(1);
    });

    it("keeps a replacement that was cut short from leaving two: a duplicate found at the next launch is archived", async () => {
      const { runtime, created, labels, archivedAt } = await setup({ shop: true });
      await runtime.openSidekick("ws-shop");
      labels["ghost"] = { [SIDEKICK_LABEL]: "true", "playbooks/project": "shop" };
      archivedAt["ghost"] = null;
      await runtime.restartSidekick("ws-shop");
      expect(archivedAt["ghost"]).toBeTruthy();
      expect(created.agents).toHaveLength(2);
      expect(Object.values(archivedAt).filter((value) => value === null)).toHaveLength(1);
    });

    it("cleans up duplicates at startup: keeps the one the record names, archives the others", async () => {
      const dir = await tempDir("sidekick-dup-");
      const root = path.join(dir, "shop");
      await write(root, `${PLAYBOOKS}/sidekick/instructions.md`, "Rules.\n");
      const store = new RunStore(path.join(dir, "data", "runs"));
      await store.init();
      await write(dir, "data/sidekick.json", JSON.stringify({ shop: { workspaceId: "side-shop", agentId: "agent-2" } }));
      const archived: string[] = [];
      const agents = ["agent-1", "agent-2", "agent-3"].map((id) => ({ agent: { id, labels: { [SIDEKICK_LABEL]: "true", "playbooks/project": "shop" }, archivedAt: null, createdAt: `2026-01-01T00:00:0${id.slice(-1)}Z` } }));
      const paseo = { agents: { ref: (id: string) => ({ archive: async () => void archived.push(id), refresh: async () => null }), list: async () => ({ entries: agents }) }, workspaces: { ref: () => ({}) } };
      const runtime = new Runtime(store, {});
      runtimes.push(runtime);
      await runtime.attach(paseo as never);
      await vi.waitFor(() => expect(archived.sort()).toEqual(["agent-1", "agent-3"]));
    });
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

  describe("event notices", () => {
    const eventSetup = async () => {
      const made = await setup({ shop: true }, { debounceMs: 0 });
      made.runtime.bus.register({ type: "t.ping", description: "", payload: z.object({ n: z.number() }), line: (event) => `- t.ping ${event.payload.n}` });
      await made.runtime.openSidekick("ws-shop");
      await made.runtime.bus.subscribe("agent-1", { kind: "agent", target: "agent-1" }, ["t.ping"]);
      const pings = () => made.sent.filter((message) => message.text.includes("t.ping"));
      return { ...made, pings };
    };

    it("keep being delivered after the Sidekick's turns end", async () => {
      const { runtime, pings } = await eventSetup();
      await runtime.bus.emit("t.ping", { n: 1 }, { source: "test" });
      await runtime.bus.flush();
      expect(pings()).toHaveLength(1);
      await runtime.onTurnEnded("agent-1", "completed");
      await runtime.bus.emit("t.ping", { n: 2 }, { source: "test" });
      await runtime.bus.flush();
      expect(pings()).toHaveLength(2);
    });

    it("wait while the Sidekick is in a turn and go out when it ends", async () => {
      const { runtime, pings, state } = await eventSetup();
      runtime.onTurnStarted("agent-1");
      state["agent-1"] = { status: "running", used: 0 };
      await runtime.bus.emit("t.ping", { n: 1 }, { source: "test" });
      await runtime.bus.flush();
      expect(pings()).toHaveLength(0);
      state["agent-1"] = { status: "idle", used: 0 };
      await runtime.onTurnEnded("agent-1", "completed");
      expect(pings()).toHaveLength(1);
    });
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
