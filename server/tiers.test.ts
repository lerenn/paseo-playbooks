import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TIERS = `
tiers:
  cheap: { provider: claude, model: claude-haiku-5-5, thinking: low }
  worker: { provider: claude, model: claude-sonnet-5-5 }
  advisor: { provider: claude, model: claude-opus-5-5, thinking: high }
`;

async function load(files: Record<string, string>, defaults: string, roleYaml?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "tiers-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  if (roleYaml !== undefined) await writeFile(path.join(root, "roles/investigator/role.yaml"), roleYaml);
  await writeFile(path.join(root, "defaults/main.yaml"), defaults);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  const loaded = await loadPlaybooks(dir);
  return loaded.entries;
}

const PB = `
title: P
agent: { tier: worker }
steps:
  - id: plain
    role: { name: implementer }
  - id: cheap
    role: { name: investigator, agent: { tier: cheap } }
  - id: tweaked
    needs: [cheap]
    role: { name: investigator, agent: { tier: advisor, thinking: medium } }
  - id: ok
    needs: [plain, tweaked]
    gate: { question: "Ship?", decider: { by: role, role: reviewer, agent: { tier: cheap } } }
`;

describe("model tiers", () => {
  it("resolve at every layer: step > role > playbook > defaults, an explicit field beating its tier", async () => {
    const [entry] = await load({ "p.yaml": PB }, `${TIERS}\nagent: { tier: advisor, mode: default }\nmanager: { tier: worker }\n`, "agent: { tier: worker }\nreadonly: true\n");
    expect(entry!.errors).toEqual([]);
    const agent = (id: string) => entry!.playbook!.steps.find((step) => step.id === id)!.agent;
    // playbook tier over the defaults' tier; fields the playbook tier leaves unset (thinking) and mode still come from the defaults
    expect(agent("plain")).toEqual({ provider: "claude", model: "claude-sonnet-5-5", thinking: "high", mode: "default" });
    // the step's tier beats the role's (worker) and the playbook's
    expect(agent("cheap")).toEqual({ provider: "claude", model: "claude-haiku-5-5", thinking: "low", mode: "default" });
    expect(agent("tweaked")).toEqual({ provider: "claude", model: "claude-opus-5-5", thinking: "medium", mode: "default" });
    expect(entry!.playbook!.steps.find((step) => step.id === "ok")!.decider).toMatchObject({ by: "role", agent: { model: "claude-haiku-5-5" } });
    expect(entry!.playbook!.manager).toEqual({ provider: "claude", model: "claude-sonnet-5-5" });
  });

  it("switching provider is one edit in the defaults", async () => {
    const swapped = TIERS.replaceAll("claude-haiku-5-5", "gpt-mini").replaceAll("provider: claude", "provider: codex");
    const [entry] = await load({ "p.yaml": PB }, `${swapped}\nagent: { tier: advisor }\n`);
    expect(entry!.playbook!.steps.find((step) => step.id === "cheap")!.agent).toMatchObject({ provider: "codex", model: "gpt-mini" });
  });

  it("refuse an unknown tier, a misplaced decider agent, and an unknown key in a tier", async () => {
    const [bad] = await load({ "p.yaml": PB.replace("tier: cheap } }\n  - id: tweaked", "tier: nope } }\n  - id: tweaked") }, TIERS);
    expect(bad!.errors.join("\n")).toMatch(/step "cheap": role\.agent: unknown tier "nope" \(defined in defaults\/main\.yaml: cheap, worker, advisor\)/);
    const [none] = await load({ "p.yaml": PB }, "agent: { provider: claude }\n");
    expect(none!.errors.join("\n")).toMatch(/unknown tier "worker"; define it under `tiers:`/);
    const [defaults] = await load({ "p.yaml": PB }, `${TIERS}\nagent: { tier: ghost }\n`);
    expect(defaults!.errors.join("\n")).toMatch(/defaults\/main\.yaml: agent: unknown tier "ghost"/);
    const [role] = await load({ "p.yaml": PB }, TIERS, "agent: { tier: ghost }\n");
    expect(role!.errors.join("\n")).toMatch(/role\.yaml: agent: unknown tier "ghost"/);
    const [human] = await load({ "p.yaml": PB.replace("by: role, role: reviewer, agent", "by: manager, agent") }, TIERS);
    expect(human!.errors.join("\n")).toMatch(/decider\.agent: only applies with `by: role`/);
    const [typo] = await load({ "p.yaml": PB }, "tiers:\n  cheap: { modle: x }\n");
    expect(typo!.errors.join("\n")).toMatch(/modle|Unrecognized key/);
  });

  it("leave playbooks without tiers unchanged", async () => {
    const [entry] = await load({ "p.yaml": "title: P\nsteps:\n  - id: a\n    role: { name: implementer }\n" }, "agent: { provider: claude, model: m }\n");
    expect(entry!.playbook!.steps[0]!.agent).toEqual({ provider: "claude", model: "m" });
  });
});

describe("provider fallback tiers", () => {
  const CHAIN = `tiers:
  cheap:
    - { provider: claude, model: claude-haiku-5-5, thinking: low }
    - { provider: codex, model: gpt-5-mini }
    - { provider: ollama, model: "qwen3:8b" }
  solo: [ { provider: claude, model: claude-sonnet-5-5 } ]
`;
  const STEPS = `title: P
steps:
  - id: a
    role: { name: investigator, agent: { tier: cheap } }
  - id: b
    role: { name: implementer, agent: { tier: solo } }
  - id: c
    needs: [b]
    role: { name: implementer }
  - id: ok
    needs: [a, c]
    gate: { question: "Ship?", decider: { by: role, role: reviewer, agent: { tier: cheap } } }
`;

  it("lists targets in order: the first is the agent's, the rest its fallback", async () => {
    const [entry] = await load({ "p.yaml": STEPS }, `${CHAIN}manager: { tier: cheap }\nagent: { tier: solo }\n`);
    expect(entry!.errors).toEqual([]);
    const pb = entry!.playbook!;
    expect(pb.steps.find((step) => step.id === "a")!.agent).toEqual({
      provider: "claude",
      model: "claude-haiku-5-5",
      thinking: "low",
      fallback: [
        { provider: "codex", model: "gpt-5-mini" },
        { provider: "ollama", model: "qwen3:8b" },
      ],
    });
    // a single-entry list is a plain block; a step without its own tier keeps the defaults' single tier
    expect(pb.steps.find((step) => step.id === "b")!.agent).toEqual({ provider: "claude", model: "claude-sonnet-5-5" });
    expect(pb.steps.find((step) => step.id === "c")!.agent).toEqual({ provider: "claude", model: "claude-sonnet-5-5" });
    expect(pb.steps.find((step) => step.id === "ok")!.decider).toMatchObject({ agent: { fallback: [{ provider: "codex" }, { provider: "ollama" }] } });
    expect(pb.manager.fallback).toHaveLength(2);
  });

  it("does not inherit a fallback into a layer that picks its own provider or model", async () => {
    const [entry] = await load({ "p.yaml": STEPS }, `${CHAIN}agent: { tier: cheap }\n`);
    const agent = (id: string) => entry!.playbook!.steps.find((step) => step.id === id)!.agent;
    expect(agent("c").fallback).toHaveLength(2);
    expect(agent("b")).toEqual({ provider: "claude", model: "claude-sonnet-5-5", thinking: "low" });
  });

  it("refuses an empty list, an unknown key, and a multi-entry tier combined with inline settings", async () => {
    const [empty] = await load({ "p.yaml": STEPS }, "tiers:\n  cheap: []\n  solo: { provider: x }\n");
    expect(empty!.errors.join("\n")).toMatch(/tiers/);
    const [typo] = await load({ "p.yaml": STEPS }, "tiers:\n  cheap: [ { modle: x } ]\n  solo: { provider: x }\n");
    expect(typo!.errors.join("\n")).toMatch(/modle|Unrecognized key/);
    const [mixed] = await load({ "p.yaml": STEPS.replace("agent: { tier: cheap } }\n  - id: b", "agent: { tier: cheap, model: opus } }\n  - id: b") }, CHAIN);
    expect(mixed!.errors.join("\n")).toMatch(/tier "cheap" lists several providers and cannot be combined with `model`: define another tier/);
    // a single-entry tier may still be tweaked
    const [single] = await load({ "p.yaml": STEPS.replace("agent: { tier: solo }", "agent: { tier: solo, thinking: high }") }, CHAIN);
    expect(single!.errors).toEqual([]);
  });

  it("reads `providers: { exhausted_for }`: a duration, 1h when absent, strict", async () => {
    const [none] = await load({ "p.yaml": STEPS }, CHAIN);
    expect(none!.playbook!.exhaustedForMs).toBe(3_600_000);
    const [ok] = await load({ "p.yaml": STEPS }, `${CHAIN}providers: { exhausted_for: 30m }\n`);
    expect(ok!.errors).toEqual([]);
    expect(ok!.playbook!.exhaustedForMs).toBe(1_800_000);
    const [bad] = await load({ "p.yaml": STEPS }, `${CHAIN}providers: { exhausted_for: soon }\n`);
    expect(bad!.errors.join("\n")).toMatch(/providers\.exhausted_for: expected a duration/);
    const [typo] = await load({ "p.yaml": STEPS }, `${CHAIN}providers: { exhausted_aftr: 1h }\n`);
    expect(typo!.errors.join("\n")).toMatch(/exhausted_aftr|Unrecognized key/);
  });
});
