import { cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasPlaybooks, loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
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
    const result = await loadPlaybooks(EXAMPLES);
    expect(result.exists).toBe(true);
    const pr = result.entries.find((entry) => entry.id === "pr")!;
    expect(pr.errors).toEqual([]);
    const playbook = pr.playbook!;
    expect(playbook.steps.map((step) => step.id)).toEqual(["investigate", "implement", "review", "local_qa", "babysit"]);
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

  it("accepts every agent mode, bypassPermissions included", async () => {
    const result = await loadPlaybooks(EXAMPLES);
    const pr = result.entries.find((entry) => entry.id === "pr")!;
    expect(pr.errors).toEqual([]);
    expect(pr.playbook!.steps.find((step) => step.id === "implement")!.agent.mode).toBe("bypassPermissions");
  });

  it("reads hidden, false by default", async () => {
    const step = "steps:\n  - id: a\n    role: investigator\n    prompt: go\n";
    const dir = await workspace({ "retro.yaml": `hidden: true\n${step}`, "pr.yaml": step });
    const { entries } = await loadPlaybooks(dir);
    expect(entries.find((entry) => entry.id === "retro")).toMatchObject({ hidden: true, errors: [] });
    expect(entries.find((entry) => entry.id === "pr")).toMatchObject({ hidden: false, errors: [] });
  });

  it("reports when no folder exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "playbooks-"));
    temps.push(dir);
    expect(await hasPlaybooks(dir)).toBe(false);
    expect((await loadPlaybooks(dir)).exists).toBe(false);
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
    const [entry] = (await loadPlaybooks(dir)).entries;
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
    const [entry] = (await loadPlaybooks(dir)).entries;
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
    const [entry] = (await loadPlaybooks(dir)).entries;
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
    const errors = (await loadPlaybooks(dir)).entries[0]!.errors.join("\n");
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
    const errors = (await loadPlaybooks(dir)).entries[0]!.errors.join("\n");
    expect(errors).toMatch(/goto "b" must point to an earlier step/);
  });

  it("reads gate choices in order, with labels and comment rules", async () => {
    const result = await loadPlaybooks(EXAMPLES);
    const gate = result.entries.find((entry) => entry.id === "capability")!.playbook!.steps.find((step) => step.id === "approve")!;
    expect(gate.outcomes).toEqual(["approved", "rejected"]);
    expect(gate.choices).toEqual([
      { id: "approved", label: "Release to dev", comment: "none" },
      { id: "rejected", label: "Request changes", comment: "required", color: "danger" },
    ]);
  });

  it("requires an on entry for every outcome but the first and failure, on agent steps and gates", async () => {
    const dir = await workspace({
      "bad.yaml": `
steps:
  - id: x
    role: reviewer
    outcomes: [success, failure, abort]
  - id: approve
    needs: [x]
    gate: Ship it?
    choices:
      ship: {}
      hold: {}
      failure: {}
`,
      "ok.yaml": `
steps:
  - id: x
    role: reviewer
    outcomes: [done, failure]
  - id: approve
    needs: [x]
    gate: Ship it?
  - id: pick
    needs: [approve]
    gate: Which?
    choices:
      ship: {}
      hold: {}
    on:
      hold: fail
`,
    });
    const entries = new Map((await loadPlaybooks(dir)).entries.map((entry) => [entry.id, entry]));
    const errors = entries.get("bad")!.errors.join("\n");
    expect(errors).toContain('step "x": outcome "abort" needs an `on` entry (complete, end, fail, goto or ask)');
    expect(errors).toContain('step "approve": choice "hold" needs an `on` entry (complete, end, fail or goto)');
    // On a gate, a choice named failure is not special.
    expect(errors).toContain('step "approve": choice "failure" needs an `on` entry');
    expect(errors).not.toContain('"ship"');
    expect(errors).not.toContain('"failure" needs an `on` entry (complete, end, fail, goto or ask)');
    // A gate without choices keeps Approve / Reject; rejected fails by default.
    expect(entries.get("ok")!.errors).toEqual([]);
  });

  it("says which template form to use in inputs and in prompts", async () => {
    const dir = await workspace({
      "bad.yaml": `
inputs:
  request: {}
steps:
  - id: a
    role: reviewer
    outputs: { plan: {} }
    inputs:
      req: "{{ inputs.request }}"
  - id: b
    role: reviewer
    needs: [a]
    prompt: "Do {{ playbook.inputs.request }} with {{ steps.a.outputs.plan }}"
`,
    });
    const errors = (await loadPlaybooks(dir)).entries[0]!.errors.join("\n");
    expect(errors).toContain('in `inputs` write "{{ playbook.inputs.request }}"');
    expect(errors).toMatch(/prompt uses "\{\{ playbook\.inputs\.request \}\}".*declare the input in the step's `inputs`, e\.g\. "request".*write "\{\{ inputs\.request \}\}"/);
    expect(errors).toMatch(/prompt uses "\{\{ steps\.a\.outputs\.plan \}\}".*e\.g\. plan: "\{\{ steps\.a\.outputs\.plan \}\}".*write "\{\{ inputs\.plan \}\}"/);
  });

  it("refuses choices on agent steps", async () => {
    const dir = await workspace({
      "bad.yaml": "steps:\n  - id: investigate\n    role: investigator\n    choices:\n      ok: {}\n",
    });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "bad")!;
    expect(entry.errors.join("\n")).toMatch(/`choices` only applies to a gate/);
  });

  it("ignores unknown keys instead of failing", async () => {
    const dir = await workspace({
      "odd.yaml": [
        "title: Odd",
        "colour: blue",
        "inputs:",
        "  request: { type: string, hint: ignored }",
        "steps:",
        "  - id: investigate",
        "    role: investigator",
        "    owner: someone",
        "    agent: { model: claude-haiku-5-5, flavour: mild }",
        "  - id: approve",
        "    needs: [investigate]",
        "    gate: Looks good?",
        "    choices:",
        "      approved: { label: Approve, emoji: yes }",
      ].join("\n"),
    });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "odd")!;
    expect(entry.errors).toEqual([]);
    expect(entry.playbook!.title).toBe("Odd");
  });

  it("reads step titles, falling back to the id; a playbook step's title names its block", async () => {
    const dir = await workspace({
      "outer.yaml": `
steps:
  - { id: investigate, role: investigator, title: Investigate the bug, short_title: Investig. }
  - { id: approve, needs: [investigate], gate: Go?, title: Approve the plan }
  - { id: pr, needs: [approve], playbook: inner, title: Pull request }
`,
      "inner.yaml": "steps:\n  - { id: review, role: reviewer }\n",
    });
    const pb = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "outer")!.playbook!;
    expect(pb.steps.map((step) => [step.id, step.title, step.shortTitle])).toEqual([
      ["investigate", "Investigate the bug", "Investig."],
      ["approve", "Approve the plan", undefined],
      ["pr.review", undefined, undefined],
    ]);
    expect(pb.blocks.pr!.title).toBe("Pull request");
  });

  it("reads silence on steps and in defaults, with off; refuses it where there is no agent", async () => {
    const steps = "steps:\n  - id: a\n    role: investigator\n    prompt: go\n  - id: b\n    role: investigator\n    prompt: go\n    silence: off\n  - id: c\n    role: investigator\n    prompt: go\n    silence: 10m\n";
    const dir = await workspace({ "defaults/main.yaml": "silence: 45m\n", "pr.yaml": steps });
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "pr")!.playbook!;
    expect(playbook.steps.map((step) => step.silenceMs)).toEqual([2_700_000, 0, 600_000]);

    const plain = await workspace({ "pr.yaml": "steps:\n  - id: a\n    role: investigator\n    prompt: go\n" });
    expect((await loadPlaybooks(plain)).entries[0]!.playbook!.steps[0]!.silenceMs).toBeUndefined();

    const bad = await workspace({
      "defaults/main.yaml": "silence: soon\n",
      "pr.yaml": "steps:\n  - id: a\n    role: investigator\n    prompt: go\n    silence: 0m\n  - id: ok\n    gate: Go?\n    silence: 5m\n    needs: [a]\n",
    });
    const errors = (await loadPlaybooks(bad)).entries.flatMap((entry) => entry.errors).join("\n");
    expect(errors).toMatch(/defaults\/main.yaml: silence: expected a duration such as 30m, or off/);
    expect(errors).toMatch(/step "a": silence: expected a duration such as 30m, or off/);
    expect(errors).toMatch(/step "ok": `silence` does not apply to a gate/);
  });

  it("refuses short_title on a playbook step", async () => {
    const dir = await workspace({
      "outer.yaml": "steps:\n  - { id: pr, playbook: inner, short_title: PR }\n",
      "inner.yaml": "steps:\n  - { id: review, role: reviewer }\n",
    });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "outer")!;
    expect(entry.errors.join("\n")).toMatch(/`short_title` does not apply to a playbook step/);
  });

  it("refuses the removed next key", async () => {
    const dir = await workspace({
      "first.yaml": `
next: [{ playbook: second }]
steps:
  - { id: a, role: reviewer }
`,
      "second.yaml": "steps:\n  - { id: b, role: reviewer }\n",
    });
    const first = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "first")!;
    expect(first.playbook).toBeNull();
    expect(first.errors.join("\n")).toMatch(/`next` was removed/);
  });

  it("also loads .paseo/playbooks/, with its own roles", async () => {
    const dir = await workspace({ "lite.yaml": "steps:\n  - { id: a, role: reviewer }\n" }, true, ".paseo/playbooks");
    expect(await hasPlaybooks(dir)).toBe(true);
    const result = await loadPlaybooks(dir);
    expect(result.roots).toEqual([path.join(dir, ".paseo/playbooks")]);
    const [entry] = result.entries;
    expect(entry!.errors).toEqual([]);
    expect(entry!.file).toBe(".paseo/playbooks/lite.yaml");
  });

  it("merges both folders and reports a playbook id defined in both", async () => {
    const dir = await workspace({ "one.yaml": "steps:\n  - { id: a, role: reviewer }\n", "same.yaml": "steps:\n  - { id: a, role: reviewer }\n" });
    await workspace({ "two.yaml": "steps:\n  - { id: b, role: local_qa }\n", "same.yaml": "steps:\n  - { id: b, role: local_qa }\n" }, true, ".paseo/playbooks", dir);
    const result = await loadPlaybooks(dir);
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
    const [entry] = (await loadPlaybooks(dir)).entries;
    expect(entry!.errors.join("\n")).toMatch(/\.paseo\/playbooks\/roles\/reviewer\/role\.yaml: file not found/);
  });
});
