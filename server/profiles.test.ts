import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findEntry } from "../shared/repos";
import { readActiveProfiles, setProfileActive } from "./config";
import { newRun, readySteps } from "./engine";
import { hasPlaybooks, loadPlaybooks } from "./loader";

const temps: string[] = [];
const BASE = ".paseo/plugins/playbooks";
const LEGACY = ".paseo/playbooks";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "profiles-"));
  temps.push(dir);
  return dir;
}

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

const ROLE = (title: string) => `title: ${title}\nreadonly: true\n`;
const playbook = (role: string) => `steps:\n  - id: a\n    role: { name: ${role}, prompt: go }\n`;

/** default: deploy + review (role `coder`); louis: deploy + personal (role `coder`, its own); coding: build. */
async function workspace(): Promise<string> {
  const dir = await tempDir();
  await put(dir, {
    [`${BASE}/deploy.yaml`]: playbook("coder"),
    [`${BASE}/review.yaml`]: playbook("coder"),
    [`${BASE}/roles/coder/role.yaml`]: ROLE("Default coder"),
    [`${BASE}/roles/coder/instructions.md`]: "default coder instructions",
    [`${BASE}/profiles/louis/deploy.yaml`]: playbook("coder"),
    [`${BASE}/profiles/louis/personal.yaml`]: playbook("coder"),
    [`${BASE}/profiles/louis/roles/coder/role.yaml`]: ROLE("Louis coder"),
    [`${BASE}/profiles/louis/roles/coder/instructions.md`]: "louis coder instructions",
    [`${BASE}/profiles/coding/build.yaml`]: playbook("builder"),
    [`${BASE}/profiles/coding/roles/builder/role.yaml`]: ROLE("Builder"),
    [`${BASE}/profiles/coding/roles/builder/instructions.md`]: "builder",
  });
  return dir;
}

const ids = (result: Awaited<ReturnType<typeof loadPlaybooks>>) => result.entries.map((entry) => entry.id).sort();

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("profiles", () => {
  it("1. discovers the default repository", async () => {
    const result = await loadPlaybooks(await workspace(), { activeProfiles: [] });
    expect(result.entries.filter((entry) => entry.repo === "default").map((entry) => entry.id).sort()).toEqual(["deploy", "review"]);
    expect(result.entries.every((entry) => entry.errors.length === 0)).toBe(true);
  });

  it("2. discovers several profiles, ignoring nested folders and stray files", async () => {
    const dir = await workspace();
    await put(dir, { [`${BASE}/profiles/louis/profiles/nested/x.yaml`]: playbook("coder"), [`${BASE}/profiles/README.md`]: "x", [`${BASE}/profiles/Bad Name/x.yaml`]: playbook("coder") });
    const result = await loadPlaybooks(dir, { activeProfiles: [] });
    expect(result.profiles.map((profile) => profile.id)).toEqual(["coding", "louis"]);
    expect(result.profiles.find((profile) => profile.id === "louis")!.playbooks).toBe(2);
    expect(result.diagnostics.join("\n")).toMatch(/Bad Name: not a profile/);
  });

  it("3. profiles are off by default", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, "home"));
    const old = process.env.PASEO_HOME;
    process.env.PASEO_HOME = path.join(dir, "home");
    try {
      const result = await loadPlaybooks(dir);
      expect(result.profiles.every((profile) => !profile.active)).toBe(true);
      expect(ids(result)).toEqual(["deploy", "review"]);
    } finally {
      if (old === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = old;
    }
  });

  it("4. activates one profile", async () => {
    const result = await loadPlaybooks(await workspace(), { activeProfiles: ["louis"] });
    expect(ids(result)).toEqual(["deploy", "louis:deploy", "louis:personal", "review"]);
    expect(result.entries.find((entry) => entry.id === "louis:personal")).toMatchObject({ repo: "louis", errors: [] });
    expect(result.entries.find((entry) => entry.id === "louis:personal")!.playbook!.id).toBe("louis:personal");
  });

  it("5. activates several profiles", async () => {
    const result = await loadPlaybooks(await workspace(), { activeProfiles: ["louis", "coding"] });
    expect(ids(result)).toEqual(["coding:build", "deploy", "louis:deploy", "louis:personal", "review"]);
    expect(result.profiles.filter((profile) => profile.active).map((profile) => profile.id)).toEqual(["coding", "louis"]);
  });

  it("6. persists the activation in the user config, never listing default", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "config.yaml");
    await writeFile(file, "other: keep\n");
    expect(await setProfileActive("louis", true, file)).toEqual(["louis"]);
    expect(await setProfileActive("coding", true, file)).toEqual(["louis", "coding"]);
    expect(await setProfileActive("louis", true, file)).toEqual(["louis", "coding"]);
    expect(await setProfileActive("default", true, file)).toEqual(["louis", "coding"]);
    expect(await readActiveProfiles(file)).toEqual(["louis", "coding"]);
    expect(await readFile(file, "utf8")).toContain("other: keep");
    expect(await setProfileActive("louis", false, file)).toEqual(["coding"]);
    await writeFile(file, "profiles:\n  active: [default, 3, louis, louis]\n");
    expect(await readActiveProfiles(file)).toEqual(["louis"]);
    await writeFile(file, "::: not yaml [");
    expect(await readActiveProfiles(file)).toEqual([]);
  });

  it("7. ignores unknown profile identifiers", async () => {
    const result = await loadPlaybooks(await workspace(), { activeProfiles: ["ghost", "coding"] });
    expect(ids(result)).toEqual(["coding:build", "deploy", "review"]);
    expect(result.diagnostics.join("\n")).toMatch(/profile "ghost" is active in the config but has no folder/);
  });

  it("8. keeps both resources on an id collision, reports it, and refuses an ambiguous bare id", async () => {
    const result = await loadPlaybooks(await workspace(), { activeProfiles: ["louis"] });
    expect(ids(result).filter((id) => id.endsWith("deploy"))).toEqual(["deploy", "louis:deploy"]);
    expect(result.diagnostics.join("\n")).toMatch(/"deploy" exists in `default` and `louis`.*ambiguous/);
    const bare = findEntry(result.entries, "deploy");
    expect(bare).toHaveProperty("error");
    expect((bare as { error: string }).error).toMatch(/default:deploy.*louis:deploy/);
    expect(findEntry(result.entries, "default:deploy")).toMatchObject({ entry: { id: "deploy", repo: "default" } });
    expect(findEntry(result.entries, "louis:deploy")).toMatchObject({ entry: { id: "louis:deploy" } });
    expect(findEntry(result.entries, "review")).toMatchObject({ entry: { id: "review" } });
    expect(findEntry(result.entries, "nope")).toEqual({ entry: undefined });
  });

  it("9. resolves roles and sub-playbooks inside the playbook's own repository", async () => {
    const dir = await workspace();
    await put(dir, {
      [`${BASE}/profiles/louis/outer.yaml`]: "steps:\n  - id: s\n    playbook: { name: personal }\n",
      [`${BASE}/outer.yaml`]: "steps:\n  - id: s\n    playbook: { name: personal }\n",
    });
    const result = await loadPlaybooks(dir, { activeProfiles: ["louis"] });
    const get = (id: string) => result.entries.find((entry) => entry.id === id)!;
    expect(get("deploy").playbook!.roles.coder!.title).toBe("Default coder");
    expect(get("louis:deploy").playbook!.roles.coder!.title).toBe("Louis coder");
    // louis' `outer` finds `personal` in louis; the default `outer` does not see it.
    expect(get("louis:outer").errors).toEqual([]);
    expect(get("louis:outer").playbook!.blocks.s!.playbook).toBe("louis:personal");
    expect(get("outer").errors.join("\n")).toMatch(/playbook "personal" not found/);
    // A profile that lacks a role does not borrow the default's.
    await put(dir, { [`${BASE}/profiles/coding/needs-coder.yaml`]: playbook("coder") });
    const again = await loadPlaybooks(dir, { activeProfiles: ["coding"] });
    expect(again.entries.find((entry) => entry.id === "coding:needs-coder")!.errors.join("\n")).toMatch(/role "coder"/);
  });

  it("10. keeps reading the legacy .paseo/playbooks folder as part of the default repository", async () => {
    const dir = await tempDir();
    await put(dir, { [`${LEGACY}/old.yaml`]: playbook("coder"), [`${LEGACY}/roles/coder/role.yaml`]: ROLE("Old"), [`${LEGACY}/roles/coder/instructions.md`]: "x" });
    expect(await hasPlaybooks(dir)).toBe(true);
    const result = await loadPlaybooks(dir, { activeProfiles: [] });
    expect(result.entries).toMatchObject([{ id: "old", repo: "default", errors: [] }]);
    expect(result.exists).toBe(true);
  });

  it("11. does not load a resource twice when both folders exist (a shared id is an error, not a duplicate)", async () => {
    const dir = await tempDir();
    await put(dir, {
      [`${BASE}/new.yaml`]: playbook("coder"),
      [`${BASE}/roles/coder/role.yaml`]: ROLE("New"),
      [`${BASE}/roles/coder/instructions.md`]: "x",
      [`${LEGACY}/old.yaml`]: playbook("coder"),
      [`${LEGACY}/new.yaml`]: playbook("coder"),
      [`${LEGACY}/roles/coder/role.yaml`]: ROLE("Old"),
      [`${LEGACY}/roles/coder/instructions.md`]: "x",
    });
    const result = await loadPlaybooks(dir, { activeProfiles: [] });
    expect(result.entries.filter((entry) => entry.id === "old")).toHaveLength(1);
    const clashing = result.entries.filter((entry) => entry.id === "new");
    expect(clashing).toHaveLength(2);
    expect(clashing.every((entry) => entry.playbook === null && /also defined in/.test(entry.errors.join(" ")))).toBe(true);
    expect(result.diagnostics.join("\n")).toMatch(/legacy location/);
    // Nothing on disk was moved or removed.
    expect(await readFile(path.join(dir, LEGACY, "old.yaml"), "utf8")).toContain("coder");
  });

  it("12. runs a playbook that comes from a profile", async () => {
    const result = await loadPlaybooks(await workspace(), { activeProfiles: ["louis"] });
    const pb = result.entries.find((entry) => entry.id === "louis:personal")!.playbook!;
    const run = newRun({ id: "run_p", playbook: pb, workspaceId: "ws", workspaceDir: "/tmp/ws", projectId: "p", branch: "b", managerAgentId: "m", inputs: {}, now: new Date().toISOString() });
    expect(run.playbook.id).toBe("louis:personal");
    expect(readySteps(run)).toEqual(["a"]);
    expect(run.playbook.roles.coder!.title).toBe("Louis coder");
  });

  it("shows a workspace that only has profiles", async () => {
    const dir = await tempDir();
    await put(dir, { [`${BASE}/profiles/louis/x.yaml`]: playbook("coder") });
    expect(await hasPlaybooks(dir)).toBe(true);
    expect((await loadPlaybooks(dir, { activeProfiles: [] })).exists).toBe(true);
  });
});
