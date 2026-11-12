import { chmod, cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
    expect(babysit.on.changes_requested).toEqual({
      kind: "goto",
      target: "implement",
      maxLoops: 3,
      decider: { by: "role", role: "gatekeeper", agent: { provider: "claude", model: "claude-opus-5-5", mode: "bypassPermissions" } },
    });
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
    const step = "steps:\n  - id: a\n    role: { name: investigator, prompt: go }\n";
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
  - { id: a, role: { name: reviewer }, needs: [b] }
  - { id: b, role: { name: reviewer }, needs: [a] }
  - { id: c, role: { name: ghost }, needs: [zzz] }
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
  - { id: a, role: { name: implementer } }
  - { id: b, role: { name: implementer } }
`,
    });
    const [entry] = (await loadPlaybooks(dir)).entries;
    expect(entry!.errors.join("\n")).toMatch(/"a" and "b" can run at the same time/);
  });

  it("errors on an ambiguous auto-matched input", async () => {
    const dir = await workspace({
      "amb.yaml": `
steps:
  - { id: a, role: { name: reviewer }, outputs: { findings: {} } }
  - { id: b, role: { name: local_qa }, outputs: { findings: {} } }
  - { id: c, role: { name: implementer }, needs: [a, b], inputs: [findings] }
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
    role: { name: reviewer, prompt: "{{ inputs.request }} {{ steps.x.outputs.y }} {{ inputs.nope }}" }
    inputs: [request]
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
    role: { name: reviewer }
    outcomes: [ok, again]
    on: { again: { goto: b } }
  - { id: b, role: { name: reviewer }, needs: [a] }
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
    role: { name: reviewer }
    outcomes: [success, failure, abort]
  - id: approve
    needs: [x]
    gate:
      question: Ship it?
      choices:
        ship: {}
        hold: {}
        failure: {}
`,
      "ok.yaml": `
steps:
  - id: x
    role: { name: reviewer }
    outcomes: [done, failure]
  - id: approve
    needs: [x]
    gate: { question: Ship it? }
  - id: pick
    needs: [approve]
    gate:
      question: Which?
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
    role: { name: reviewer }
    outputs: { plan: {} }
    inputs:
      req: "{{ inputs.request }}"
  - id: b
    role: { name: reviewer, prompt: "Do {{ playbook.inputs.request }} with {{ steps.a.outputs.plan }}" }
    needs: [a]
`,
    });
    const errors = (await loadPlaybooks(dir)).entries[0]!.errors.join("\n");
    expect(errors).toContain('in `inputs` write "{{ playbook.inputs.request }}"');
    expect(errors).toMatch(/prompt uses "\{\{ playbook\.inputs\.request \}\}".*declare the input in the step's `inputs`, e\.g\. "request".*write "\{\{ inputs\.request \}\}"/);
    expect(errors).toMatch(/prompt uses "\{\{ steps\.a\.outputs\.plan \}\}".*e\.g\. plan: "\{\{ steps\.a\.outputs\.plan \}\}".*write "\{\{ inputs\.plan \}\}"/);
  });

  it("refuses choices on agent steps", async () => {
    const dir = await workspace({
      "bad.yaml": "steps:\n  - id: investigate\n    role: { name: investigator }\n    choices:\n      ok: {}\n",
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
        "    role:",
        "      name: investigator",
        "      agent: { model: claude-haiku-5-5, flavour: mild }",
        "    owner: someone",
        "  - id: approve",
        "    needs: [investigate]",
        "    gate:",
        "      question: Looks good?",
        "      choices:",
        "        approved: { label: Approve, emoji: yes }",
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
  - { id: investigate, role: { name: investigator }, title: Investigate the bug, short_title: Investig. }
  - { id: approve, needs: [investigate], gate: { question: Go? }, title: Approve the plan }
  - { id: pr, needs: [approve], playbook: { name: inner }, title: Pull request }
`,
      "inner.yaml": "steps:\n  - { id: review, role: { name: reviewer } }\n",
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
    const steps = "steps:\n  - id: a\n    role: { name: investigator, prompt: go }\n  - id: b\n    role: { name: investigator, prompt: go, silence: off }\n  - id: c\n    role: { name: investigator, prompt: go, silence: 10m }\n";
    const dir = await workspace({ "defaults/main.yaml": "role: { silence: 45m }\n", "pr.yaml": steps });
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "pr")!.playbook!;
    expect(playbook.steps.map((step) => step.silenceMs)).toEqual([2_700_000, 0, 600_000]);

    const plain = await workspace({ "pr.yaml": "steps:\n  - id: a\n    role: { name: investigator, prompt: go }\n" });
    expect((await loadPlaybooks(plain)).entries[0]!.playbook!.steps[0]!.silenceMs).toBeUndefined();

    const bad = await workspace({
      "defaults/main.yaml": "role: { silence: soon }\n",
      "pr.yaml": "steps:\n  - id: a\n    role: { name: investigator, prompt: go, silence: 0m }\n  - id: ok\n    gate: { question: Go? }\n    silence: 5m\n    needs: [a]\n",
    });
    const errors = (await loadPlaybooks(bad)).entries.flatMap((entry) => entry.errors).join("\n");
    expect(errors).toMatch(/defaults\/main.yaml: role.silence: expected a duration such as 30m, or off/);
    expect(errors).toMatch(/step "a": role.silence: expected a duration such as 30m, or off/);
    expect(errors).toMatch(/step "ok": `silence` only applies to an agent step \(under `role:`\)/);
  });

  it("reads archive_agents on steps and in defaults; refuses it where there is no agent", async () => {
    const steps = "steps:\n  - id: a\n    role: { name: investigator, prompt: go }\n  - id: b\n    role: { name: investigator, prompt: go, archive_agents: true }\n";
    const dir = await workspace({ "defaults/main.yaml": "role: { archive_agents: false }\n", "pr.yaml": steps });
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "pr")!.playbook!;
    expect(playbook.steps.map((step) => step.archiveAgents)).toEqual([false, true]);

    const plain = await workspace({ "pr.yaml": "steps:\n  - id: a\n    role: { name: investigator, prompt: go }\n" });
    expect((await loadPlaybooks(plain)).entries[0]!.playbook!.steps[0]!.archiveAgents).toBeUndefined();

    const bad = await workspace({ "pr.yaml": "steps:\n  - id: a\n    role: { name: investigator, prompt: go }\n  - id: ok\n    gate: { question: Go? }\n    archive_agents: false\n    needs: [a]\n" });
    expect((await loadPlaybooks(bad)).entries.flatMap((entry) => entry.errors).join("\n")).toMatch(/step "ok": `archive_agents` only applies to an agent step/);
  });

  it("refuses short_title on a playbook step", async () => {
    const dir = await workspace({
      "outer.yaml": "steps:\n  - { id: pr, playbook: { name: inner }, short_title: PR }\n",
      "inner.yaml": "steps:\n  - { id: review, role: { name: reviewer } }\n",
    });
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "outer")!;
    expect(entry.errors.join("\n")).toMatch(/`short_title` does not apply to a playbook step/);
  });

  describe("step kind blocks", () => {
    const errorsOf = async (files: Record<string, string>, id = "pb") =>
      (await loadPlaybooks(await workspace(files))).entries.find((entry) => entry.id === id)!.errors;

    describe("role.completion.auto", () => {
      const step = (extra: string) => `
steps:
  - id: qa
    outcomes: [success, merged, needs_work, failure]
    on: { needs_work: { goto: qa, max_loops: 2 }, merged: end }
    role: { name: reviewer, completion: ${extra} }
`;
      it("reads the outcomes the plugin applies", async () => {
        const entry = (await loadPlaybooks(await workspace({ "pb.yaml": step("{ auto: [success, merged, needs_work] }") }))).entries.find((candidate) => candidate.id === "pb")!;
        expect(entry.errors).toEqual([]);
        expect(entry.playbook!.steps[0]!.autoComplete).toEqual(["success", "merged", "needs_work"]);
      });
      it("is unset by default", async () => {
        const entry = (await loadPlaybooks(await workspace({ "pb.yaml": "steps:\n  - { id: a, role: { name: reviewer } }\n" }))).entries.find((candidate) => candidate.id === "pb")!;
        expect(entry.playbook!.steps[0]!.autoComplete).toBeUndefined();
      });
      it("refuses an outcome the step does not declare", async () => {
        expect(await errorsOf({ "pb.yaml": step("{ auto: [success, nope] }") })).toEqual([expect.stringContaining('role.completion.auto: "nope" is not an outcome of this step')]);
      });
      it("refuses failures and asks", async () => {
        expect(await errorsOf({ "pb.yaml": step("{ auto: [failure] }") })).toEqual([expect.stringContaining('"failure" is a failure')]);
        const asks = `
steps:
  - id: qa
    outcomes: [success, asking]
    on: { asking: { ask: "Which way?" } }
    role: { name: reviewer, completion: { auto: [asking] } }
`;
        expect(await errorsOf({ "pb.yaml": asks })).toEqual([expect.stringContaining('"asking" opens an ask for a human')]);
      });
      it("refuses an empty list, a duplicate and an unknown key", async () => {
        expect((await errorsOf({ "pb.yaml": step("{ auto: [] }") })).length).toBeGreaterThan(0);
        expect((await errorsOf({ "pb.yaml": step("{ auto: [success], manager: false }") })).length).toBeGreaterThan(0);
        expect(await errorsOf({ "pb.yaml": step("{ auto: [success, success] }") })).toEqual([expect.stringContaining("duplicate outcome")]);
      });
      it("is refused on a gate, script, hand-off, branch and fan-out step", async () => {
        for (const kind of ["gate: { question: Ok? }", "script: { run: x.sh }", "handoff: { name: other }", "branch: { cases: [{ name: other }] }", "fanout: { playbook: sub, items: '[]', inputs: {} }"]) {
          const errors = await errorsOf({ "pb.yaml": `steps:\n  - { id: a, role: { name: reviewer, completion: { auto: [success] } }, ${kind} }\n` });
          expect(errors.some((message) => message.includes("set exactly one of"))).toBe(true);
        }
      });
    });

    it("reads each kind's block into the step", async () => {
      const dir = await workspace({
        "scripts/wait.sh": "#!/bin/sh\nexit 0\n",
        "sub.yaml": "steps:\n  - { id: look, role: { name: reviewer } }\n",
        "pb.yaml": `
steps:
  - id: review
    role:
      name: reviewer
      prompt: |
        Look closely.
      silence: 30m
      archive_agents: false
      agent: { model: claude-haiku-5-5 }
  - id: approve
    needs: [review]
    gate: { question: Ship it?, choices: { ship: ~, hold: { comment: required } } }
    on: { hold: { goto: review } }
  - id: wait
    needs: [approve]
    script: { run: wait.sh, poll: 30s }
  - id: sub
    needs: [wait]
    playbook: { name: sub }
`,
      });
      await chmod(path.join(dir, ".paseo/plugins/playbooks/scripts/wait.sh"), 0o755);
      const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "pb")!;
      expect(entry.errors).toEqual([]);
      const byId = Object.fromEntries(entry.playbook!.steps.map((step) => [step.id, step]));
      expect(byId.review).toMatchObject({ kind: "agent", role: "reviewer", prompt: "Look closely.\n", silenceMs: 1_800_000, archiveAgents: false });
      expect(byId.review!.agent.model).toBe("claude-haiku-5-5");
      expect(byId.approve).toMatchObject({ kind: "gate", gate: "Ship it?", outcomes: ["ship", "hold"] });
      expect(byId.approve!.choices.map((choice) => [choice.id, choice.comment])).toEqual([["ship", "none"], ["hold", "required"]]);
      expect(byId.wait).toMatchObject({ kind: "script", script: ".paseo/plugins/playbooks/scripts/wait.sh", pollMs: 30_000 });
      expect(byId["sub.look"]).toMatchObject({ kind: "agent", role: "reviewer" });
    });

    it("refuses the plain-string form with the block to write", async () => {
      const errors = await errorsOf({
        "sub.yaml": "steps:\n  - { id: look, role: { name: reviewer } }\n",
        "pb.yaml": `
steps:
  - id: review
    role: reviewer
    prompt: Look closely.
  - id: approve
    needs: [review]
    gate: Ship it?
  - id: sub
    needs: [approve]
    playbook: sub
after:
  - id: wait
    script: wait_ci
    poll: 30s
`,
      });
      expect(errors).toContain('.paseo/plugins/playbooks/pb.yaml: step "review": role: write `role: { name: reviewer, prompt: Look closely. }`');
      expect(errors).toContain('.paseo/plugins/playbooks/pb.yaml: step "approve": gate: write `gate: { question: Ship it? }`');
      expect(errors).toContain('.paseo/plugins/playbooks/pb.yaml: step "sub": playbook: write `playbook: { name: sub }`');
      expect(errors).toContain('.paseo/plugins/playbooks/pb.yaml: after "wait": script: write `script: { run: wait_ci, poll: 30s }`');
    });

    it("refuses a kind field written flat on the step, with where it moved", async () => {
      const errors = await errorsOf({
        "pb.yaml": `
steps:
  - id: review
    role: { name: reviewer }
    prompt: "Review {{ inputs.x }}"
    silence: 30m
    agent: { model: claude-haiku-5-5 }
  - id: approve
    needs: [review]
    gate: { question: Ship it? }
    choices: { ship: ~, hold: ~ }
  - id: other
    needs: [approve]
    role: { name: reviewer }
    archive_agents: false
    poll: 1m
`,
      });
      const at = ".paseo/plugins/playbooks/pb.yaml";
      expect(errors).toContain(
        `${at}: step "review": \`prompt\`, \`silence\` and \`agent\` moved under \`role:\`: write \`role: { name: reviewer, prompt: "Review {{ inputs.x }}", silence: 30m, agent: { model: claude-haiku-5-5 } }\``,
      );
      expect(errors).toContain(`${at}: step "approve": \`choices\` moved under \`gate:\`: write \`gate: { question: Ship it?, choices: { ship: ~, hold: ~ } }\``);
      expect(errors).toContain(`${at}: step "other": \`archive_agents\` moved under \`role:\`: write \`role: { name: reviewer, archive_agents: false }\``);
      expect(errors).toContain(`${at}: step "other": \`poll\` only applies to a script step (under \`script:\`)`);
    });

    it("loads script.wake_on and refuses its misuse", async () => {
      const files = {
        "scripts/wait.sh": "#!/bin/sh\n",
        "ok.yaml": `
steps:
  - id: wait
    script:
      run: wait.sh
      poll: 10m
      wake_on:
        - { types: [job.advanced, job.settled], filter: { playbook: other_pipeline, station: production } }
        - { types: ["step.*"] }
`,
        "schema.yaml": `
steps:
  - id: e
    role: { name: reviewer, wake_on: [{ types: [job.settled] }] }
`,
        "empty.yaml": `
steps:
  - id: f
    script: { run: wait.sh, poll: 1m, wake_on: [] }
`,
        "bad.yaml": `
steps:
  - id: a
    script: { run: wait.sh, wake_on: [{ types: [job.settled] }] }
  - id: b
    needs: [a]
    script: { run: wait.sh, poll: 1m, wake_on: [{ types: [job.settledd] }] }
  - id: c
    needs: [b]
    script: { run: wait.sh, poll: 1m, wake_on: [{ types: [job.settled], filter: { nope: 1 } }] }
  - id: d
    needs: [c]
    role: { name: reviewer }
    wake_on: [{ types: [job.settled] }]
  - id: g
    needs: [d]
    script: { run: wait.sh, poll: 1m, wake_on: [{ types: [job.settled], filter: { olderThanMinutes: 5 } }] }
`,
      };
      const dir = await workspace(files);
      await chmod(path.join(dir, ".paseo/plugins/playbooks/scripts/wait.sh"), 0o755);
      const result = await loadPlaybooks(dir);
      const ok = result.entries.find((candidate) => candidate.id === "ok")!;
      expect(ok.errors).toEqual([]);
      const wait = ok.playbook!.steps.find((step) => step.id === "wait")!;
      expect(wait.wakeOn).toEqual([
        { types: ["job.advanced", "job.settled"], filter: { playbook: "other_pipeline", station: "production" } },
        { types: ["step.*"], filter: {} },
      ]);
      const errors = result.entries.find((candidate) => candidate.id === "bad")!.errors.join("\n");
      expect(errors).toMatch(/step "a": script.wake_on needs `poll`/);
      expect(errors).toMatch(/step "b": script.wake_on\[0\]: no event type matches "job.settledd" \(known: .*job.settled/);
      expect(errors).toMatch(/step "c": script.wake_on\[0\]: filter "nope" is not a field of job.settled \(fields: .*station/);
      expect(errors).toContain('step "d": `wake_on` only applies to a script step (under `script:`)');
      expect(result.entries.find((candidate) => candidate.id === "schema")!.errors.join("\n")).toMatch(/steps.0.role: Unrecognized key: "wake_on"/);
      expect(result.entries.find((candidate) => candidate.id === "empty")!.errors.join("\n")).toMatch(/steps.0.script.wake_on/);
      expect(errors).toMatch(/step "g": script.wake_on\[0\]: filter "olderThanMinutes" is only for subscribe_events/);
    });

    it("refuses an unknown key or a missing required field in a block", async () => {
      expect(await errorsOf({ "pb.yaml": "steps:\n  - id: a\n    role: { name: reviewer, promt: hi }\n" })).toEqual([
        '.paseo/plugins/playbooks/pb.yaml: steps.0.role: Unrecognized key: "promt"',
      ]);
      expect((await errorsOf({ "pb.yaml": "steps:\n  - id: a\n    script: { run: x.sh, timeout: 5m }\n" })).join("\n")).toMatch(/steps.0.script: Unrecognized key: "timeout"/);
      expect((await errorsOf({ "pb.yaml": "steps:\n  - id: a\n    gate: { choices: { ok: ~ } }\n" })).join("\n")).toMatch(/steps.0.gate.question: Invalid input/);
      expect((await errorsOf({ "pb.yaml": "steps:\n  - id: a\n    role: { name: reviewer }\nafter:\n  - id: b\n    playbook: { name: x, inputs: {} }\n" })).join("\n")).toMatch(
        /after.0.playbook: Unrecognized key: "inputs"/,
      );
    });

    it("keeps the shared fields on the step and refuses them on the kinds they do not fit", async () => {
      const errors = (
        await errorsOf({
          "sub.yaml": "steps:\n  - { id: look, role: { name: reviewer } }\n",
          "pb.yaml": "steps:\n  - id: a\n    gate: { question: Go? }\n    timeout: 5m\n  - id: b\n    needs: [a]\n    playbook: { name: sub }\n    outputs: { x: {} }\n",
        })
      ).join("\n");
      expect(errors).toMatch(/step "a": `timeout` does not apply to a gate/);
      expect(errors).toMatch(/step "b": `outputs` does not apply to a playbook step/);
    });

    it("reads silence and archive_agents under role: in the defaults, and refuses them flat", async () => {
      const steps = "steps:\n  - { id: a, role: { name: reviewer } }\n";
      const dir = await workspace({ "defaults/main.yaml": "timeout: 1h\nrole: { silence: 20m, archive_agents: false }\n", "pb.yaml": steps });
      const step = (await loadPlaybooks(dir)).entries[0]!.playbook!.steps[0]!;
      expect(step).toMatchObject({ timeoutMs: 3_600_000, silenceMs: 1_200_000, archiveAgents: false });

      const old = await errorsOf({ "defaults/main.yaml": "silence: 20m\narchive_agents: false\n", "pb.yaml": steps });
      expect(old).toContain(
        ".paseo/plugins/playbooks/defaults/main.yaml: `silence` and `archive_agents` moved under `role:`: write `role: { silence: 20m, archive_agents: false }`",
      );
      expect((await errorsOf({ "defaults/main.yaml": "role: { silence: 20m, prompt: hi }\n", "pb.yaml": steps })).join("\n")).toMatch(
        /defaults\/main.yaml: role: Unrecognized key: "prompt"/,
      );
    });
  });

  it("refuses the removed next key", async () => {
    const dir = await workspace({
      "first.yaml": `
next: [{ playbook: second }]
steps:
  - { id: a, role: { name: reviewer } }
`,
      "second.yaml": "steps:\n  - { id: b, role: { name: reviewer } }\n",
    });
    const first = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "first")!;
    expect(first.playbook).toBeNull();
    expect(first.errors.join("\n")).toMatch(/`next` was removed/);
  });

  it("lists manager instructions: the repository's, the playbook's, then each sub-playbook's once", async () => {
    const dir = await workspace({
      "defaults/manager.md": "Post updates in #releases.\n",
      "outer.yaml": `
manager: { prompt: "Brief steps in French." }
steps:
  - { id: a, playbook: { name: inner } }
  - { id: b, playbook: { name: inner }, needs: [a] }
  - { id: c, playbook: { name: quiet }, needs: [b] }
after:
  - { id: retro, playbook: { name: retro } }
`,
      "inner.yaml": "manager:\n  prompt: |\n    Check the PR exists.\nsteps:\n  - { id: x, playbook: { name: deep } }\n",
      "deep.yaml": "manager: { prompt: Read the CI logs. }\nsteps:\n  - { id: y, role: { name: reviewer } }\n",
      "quiet.yaml": "manager: { prompt: \"  \" }\nsteps:\n  - { id: z, role: { name: reviewer } }\n",
      "retro.yaml": "manager: { prompt: Keep the retro short. }\nsteps:\n  - { id: r, role: { name: reviewer } }\n",
    });
    const outer = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "outer")!;
    expect(outer.errors).toEqual([]);
    expect(outer.playbook!.managerInstructions).toEqual([
      { playbook: null, text: "Post updates in #releases." },
      { playbook: "outer", text: "Brief steps in French." },
      { playbook: "inner", text: "Check the PR exists." },
      { playbook: "deep", text: "Read the CI logs." },
      { playbook: "retro", text: "Keep the retro short." },
    ]);
  });

  it("has no manager instructions by default; refuses an empty defaults/manager.md and unknown manager keys", async () => {
    const step = "steps:\n  - { id: a, role: { name: reviewer } }\n";
    const plain = await workspace({ "pr.yaml": step });
    expect((await loadPlaybooks(plain)).entries[0]!.playbook!.managerInstructions).toEqual([]);
    const empty = await workspace({ "pr.yaml": step, "defaults/manager.md": "\n" });
    expect((await loadPlaybooks(empty)).entries[0]!.errors.join("\n")).toMatch(/defaults\/manager\.md: empty/);
    const unknown = await workspace({ "pr.yaml": `manager: { mode: default }\n${step}` });
    const entry = (await loadPlaybooks(unknown)).entries[0]!;
    expect(entry.playbook).toBeNull();
    expect(entry.errors.join("\n")).toMatch(/manager/);
  });

  it("also loads .paseo/playbooks/, with its own roles", async () => {
    const dir = await workspace({ "lite.yaml": "steps:\n  - { id: a, role: { name: reviewer } }\n" }, true, ".paseo/playbooks");
    expect(await hasPlaybooks(dir)).toBe(true);
    const result = await loadPlaybooks(dir);
    expect(result.roots).toEqual([path.join(dir, ".paseo/playbooks")]);
    const [entry] = result.entries;
    expect(entry!.errors).toEqual([]);
    expect(entry!.file).toBe(".paseo/playbooks/lite.yaml");
  });

  it("merges both folders and reports a playbook id defined in both", async () => {
    const dir = await workspace({ "one.yaml": "steps:\n  - { id: a, role: { name: reviewer } }\n", "same.yaml": "steps:\n  - { id: a, role: { name: reviewer } }\n" });
    await workspace({ "two.yaml": "steps:\n  - { id: b, role: { name: local_qa } }\n", "same.yaml": "steps:\n  - { id: b, role: { name: local_qa } }\n" }, true, ".paseo/playbooks", dir);
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
    await workspace({ "solo.yaml": "steps:\n  - { id: a, role: { name: reviewer } }\n" }, false, ".paseo/playbooks", dir);
    const [entry] = (await loadPlaybooks(dir)).entries;
    expect(entry!.errors.join("\n")).toMatch(/\.paseo\/playbooks\/roles\/reviewer\/role\.yaml: file not found/);
  });
});
