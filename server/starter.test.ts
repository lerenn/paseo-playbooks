import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaybooks } from "./loader";
import { createStarter } from "./starter";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tmp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "starter-"));
  temps.push(dir);
  return dir;
};

describe("starter playbook", () => {
  it("is written into an empty workspace and loads without errors", async () => {
    const dir = await tmp();
    const files = await createStarter(dir);
    expect(files).toEqual([
      ".paseo/plugins/playbooks/hello.yaml",
      ".paseo/plugins/playbooks/roles/writer/role.yaml",
      ".paseo/plugins/playbooks/roles/writer/instructions.md",
    ]);
    const loaded = await loadPlaybooks(dir);
    const entry = loaded.entries.find((candidate) => candidate.id === "hello")!;
    expect(entry.errors).toEqual([]);
    expect(entry.playbook!.steps.map((step) => step.id)).toEqual(["write", "approve"]);
  });

  it("refuses a workspace that already has playbooks, and never overwrites", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, ".paseo/playbooks"), { recursive: true });
    await writeFile(path.join(dir, ".paseo/playbooks/mine.yaml"), "title: Mine\nsteps: []\n");
    await expect(createStarter(dir)).rejects.toThrow(/already has playbooks/);

    const other = await tmp();
    await mkdir(path.join(other, ".paseo/plugins/playbooks/roles/writer"), { recursive: true });
    await writeFile(path.join(other, ".paseo/plugins/playbooks/roles/writer/role.yaml"), "title: Mine\n");
    await expect(createStarter(other)).rejects.toThrow(/role.yaml already exists/);
  });
});
