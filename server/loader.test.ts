import { cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasPlaybooks, loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const OPEN_CAP = { allowedModes: { claude: ["default", "acceptEdits", "bypassPermissions"] } };
const temps: string[] = [];

async function workspace(files: Record<string, string>, withExampleRoles = true, folder = ".paseo/plugins/playbooks", dir?: string): Promise<string> {
  if (!dir) {
    dir = await mkdtemp(path.join(tmpdir(), "playbooks-"));
    temps.push(dir);
  }
  const root = path.join(dir, folder);
  await mkdir(root, { recursive: true });
  if (withExampleRoles) await cp(path.join(EXAMPLES, ".paseo", "plugins", "playbooks", "roles"), path.join(root, "roles"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPlaybooks", () => {
  it("loads the example PR playbook with wiring resolved", async () => {
    const result = await loadPlaybooks(EXAMPLES, OPEN_CAP);
    expect(result.exists).toBe(true);
    const pr = result.entries.find((entry) => entry.id === "pr")!;
    expect(pr.errors).toEqual([]);
    const playbook = pr.playbook!;
    expect(playbook.steps.map((step) => step.id)).toEqual(["investigate", "implement", "review", "local_qa", "babysit", "pr_approval"]);
    const implement = playbook.steps.find((step) => step.id === "implement")!;
    expect(implement.inputs.plan).toMatchObject({ auto: true, label: "investigate.plan", source: "{{ steps.investigate.outputs.plan }}" });
    expect(implement.inputs.request).toMatchObject({ auto: true, label: "playbook.request" });
    expect(implement.agent).toEqual({ provider: "claude", model: "claude-opus-5-5", mode: "bypassPermissions" });
    expect(implement.timeoutMs).toBe(3_600_000);
    const babysit = playbook.steps.find((step) => step.id === "babysit")!;
    expect(babysit.inputs.review).toMatchObject({ auto: false, label: "review.findings" });
    expect(babysit.on.changes_requested).toEqual({ kind: "goto", target: "implement", maxLoops: 3 });
    expect(playbook.outputs.pr_url).toMatchObject({ auto: true, label: "implement.pr_url" });
    expect(playbook.manager).toEqual({ provider: "claude", model: "claude-opus-5-5", mode: "default" });
    expect(playbook.roles.reviewer!.readonly).toBe(true);
  });

  it("refuses modes outside the daemon cap", async () => {
    const result = await loadPlaybooks(EXAMPLES, { allowedModes: { claude: ["default"] } });
    const pr = result.entries.find((entry) => entry.id === "pr")!;
    expect(pr.playbook).toBeNull();
    expect(pr.errors.join("\n")).toMatch(/bypassPermissions.*not allowed/);
  });

  it("reports when no folder exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "playbooks-"));
    temps.push(dir);
    expect(await hasPlaybooks(dir)).toBe(false);
    expect((await loadPlaybooks(dir, OPEN_CAP)).exists).toBe(false);
  });

  it("flags cycles, unknown needs and missing roles", async () => {
    const dir = await workspace({
      "bad.yaml": `
steps:
  - { id: a, role: reviewer, needs: [b] }
  - { id: b, role: reviewer, needs: [a] }
  - { id: c, role: ghost, needs: [zzz] }
`,
    });
    const [entry] = (await loadPlaybooks(dir, OPEN_CAP)).entries;
    const errors = entry!.errors.join("\n");
    expect(entry!.playbook).toBeNull();
    expect(errors).toMatch(/role "ghost"/);
    expect(errors).toMatch(/needs unknown step "zzz"/);
    expect(errors).toMatch(/cycle/);
  });

  it("refuses two concurrent steps that may both edit files", async () => {
    const dir = await workspace({
      "two.yaml": `
steps:
  - { id: a, role: implementer }
  - { id: b, role: implementer }
`,
    });
    const [entry] = (await loadPlaybooks(dir, OPEN_CAP)).entries;
    expect(entry!.errors.join("\n")).toMatch(/"a" and "b" can run at the same time/);
  });

  it("errors on an ambiguous auto-matched input", async () => {
    const dir = await workspace({
      "amb.yaml": `
steps:
  - { id: a, role: reviewer, outputs: { findings: {} } }
  - { id: b, role: local_qa, outputs: { findings: {} } }
  - { id: c, role: implementer, needs: [a, b], inputs: [findings] }
`,
    });
    const [entry] = (await loadPlaybooks(dir, OPEN_CAP)).entries;
    expect(entry!.errors.join("\n")).toMatch(/input "findings" matches outputs of several steps \(a, b\)/);
  });

  it("only allows inputs, run.id and attempt in prompts", async () => {
    const dir = await workspace({
      "tpl.yaml": `
inputs: { request: { required: true } }
steps:
  - id: a
    role: reviewer
    inputs: [request]
    prompt: "{{ inputs.request }} {{ steps.x.outputs.y }} {{ inputs.nope }}"
`,
    });
    const errors = (await loadPlaybooks(dir, OPEN_CAP)).entries[0]!.errors.join("\n");
    expect(errors).toMatch(/steps\.x\.outputs\.y/);
    expect(errors).toMatch(/inputs\.nope.*no such input/);
  });

  it("requires goto targets to be earlier steps", async () => {
    const dir = await workspace({
      "goto.yaml": `
steps:
  - id: a
    role: reviewer
    outcomes: [ok, again]
    on: { again: { goto: b } }
  - { id: b, role: reviewer, needs: [a] }
`,
    });
    const errors = (await loadPlaybooks(dir, OPEN_CAP)).entries[0]!.errors.join("\n");
    expect(errors).toMatch(/goto "b" must point to an earlier step/);
  });

  it("reads gate choices in order, with labels and comment rules", async () => {
    const result = await loadPlaybooks(EXAMPLES, OPEN_CAP);
    const gate = result.entries.find((entry) => entry.id === "pr")!.playbook!.steps.find((step) => step.id === "pr_approval")!;
    expect(gate.outcomes).toEqual(["approved", "rejected"]);
    expect(gate.choices).toEqual([
      { id: "approved", label: "Approve", comment: "none" },
      { id: "rejected", label: "Request changes", comment: "required", color: "danger" },
    ]);
  });

  it("refuses choices on agent steps", async () => {
    const dir = await workspace({
      "bad.yaml": "steps:\n  - id: investigate\n    role: investigator\n    choices:\n      ok: {}\n",
    });
    const entry = (await loadPlaybooks(dir, OPEN_CAP)).entries.find((candidate) => candidate.id === "bad")!;
    expect(entry.errors.join("\n")).toMatch(/`choices` only applies to a gate/);
  });

  it("validates next chains", async () => {
    const dir = await workspace({
      "first.yaml": `
outputs: { pr_url: {} }
next: [{ playbook: second }]
steps:
  - { id: a, role: reviewer, outputs: { pr_url: {} } }
`,
      "second.yaml": `
inputs:
  pr_url: { required: true }
  version: { required: true }
steps:
  - { id: b, role: reviewer, inputs: [pr_url] }
`,
    });
    const entries = (await loadPlaybooks(dir, OPEN_CAP)).entries;
    const first = entries.find((entry) => entry.id === "first")!;
    expect(first.errors.join("\n")).toMatch(/required input "version" has no matching output/);
  });

  it("also loads .paseo/playbooks/, with its own roles", async () => {
    const dir = await workspace({ "lite.yaml": "steps:\n  - { id: a, role: reviewer }\n" }, true, ".paseo/playbooks");
    expect(await hasPlaybooks(dir)).toBe(true);
    const result = await loadPlaybooks(dir, OPEN_CAP);
    expect(result.roots).toEqual([path.join(dir, ".paseo/playbooks")]);
    const [entry] = result.entries;
    expect(entry!.errors).toEqual([]);
    expect(entry!.file).toBe(".paseo/playbooks/lite.yaml");
  });

  it("merges both folders and reports a playbook id defined in both", async () => {
    const dir = await workspace({ "one.yaml": "steps:\n  - { id: a, role: reviewer }\n", "same.yaml": "steps:\n  - { id: a, role: reviewer }\n" });
    await workspace({ "two.yaml": "steps:\n  - { id: b, role: local_qa }\n", "same.yaml": "steps:\n  - { id: b, role: local_qa }\n" }, true, ".paseo/playbooks", dir);
    const result = await loadPlaybooks(dir, OPEN_CAP);
    expect(result.roots).toHaveLength(2);
    const byFile = Object.fromEntries(result.entries.map((entry) => [entry.file, entry]));
    expect(byFile[".paseo/plugins/playbooks/one.yaml"]!.playbook).not.toBeNull();
    expect(byFile[".paseo/playbooks/two.yaml"]!.playbook).not.toBeNull();
    for (const file of [".paseo/plugins/playbooks/same.yaml", ".paseo/playbooks/same.yaml"]) {
      expect(byFile[file]!.playbook).toBeNull();
      expect(byFile[file]!.errors.join("\n")).toMatch(/playbook id "same" is also defined in/);
    }
  });

  it("does not share roles across folders", async () => {
    const dir = await workspace({}, true);
    await workspace({ "solo.yaml": "steps:\n  - { id: a, role: reviewer }\n" }, false, ".paseo/playbooks", dir);
    const [entry] = (await loadPlaybooks(dir, OPEN_CAP)).entries;
    expect(entry!.errors.join("\n")).toMatch(/\.paseo\/playbooks\/roles\/reviewer\/role\.yaml: file not found/);
  });
});
