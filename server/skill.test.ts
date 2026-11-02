import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";

const ROOT = path.resolve(__dirname, "..");
const OPEN_CAP = { allowedModes: { claude: ["default", "acceptEdits", "bypassPermissions"] } };
let workspace = "";

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** The skill teaches agents the format; its examples must pass the validator. */
describe("skills/paseo-playbooks/SKILL.md", () => {
  it("has a playbook example that validates", async () => {
    const skill = await readFile(path.join(ROOT, "skills", "paseo-playbooks", "SKILL.md"), "utf8");
    const section = skill.slice(skill.indexOf("## A playbook"));
    const example = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
    expect(example).toBeTruthy();
    workspace = await mkdtemp(path.join(tmpdir(), "playbooks-skill-"));
    const root = path.join(workspace, ".paseo", "plugins", "playbooks");
    await mkdir(root, { recursive: true });
    await cp(path.join(ROOT, "examples", ".paseo", "plugins", "playbooks", "roles"), path.join(root, "roles"), { recursive: true });
    await writeFile(path.join(root, "pr.yaml"), example!);
    // The example chains to "release"; give it a minimal one.
    await writeFile(path.join(root, "release.yaml"), "steps:\n  - { id: deploy, role: implementer }\n");
    const result = await loadPlaybooks(workspace, OPEN_CAP);
    const pr = result.entries.find((entry) => entry.id === "pr")!;
    expect(pr.errors).toEqual([]);
    expect(pr.playbook?.concurrency).toBe(1);
  });
});
