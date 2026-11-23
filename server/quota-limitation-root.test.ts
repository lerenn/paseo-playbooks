import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "./runtime";
import { RunStore } from "./store";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A checkout with one playbook; `defaults` is its defaults/main.yaml. */
async function checkout(defaults: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-root-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "defaults/main.yaml"), defaults);
  await writeFile(path.join(root, "release.yaml"), "id: release\ntitle: Release\nsteps:\n  - id: release\n    role: { name: implementer }\n    outputs: { pr: {} }\n");
  return dir;
}

describe("Quota limitation tab: which checkout is read", () => {
  it("reads the project's main checkout, not the stale run worktree the panel listed", async () => {
    const main = await checkout("quota_limits: { quota: { usable_percent: 90 } }\n");
    const stale = await checkout("");
    const store = new RunStore(path.join(main, "runs"));
    await store.init();
    const runtime = new Runtime(store);
    runtimes.push(runtime);
    await runtime.attach({ agents: { ref: () => ({}) } } as never);
    vi.spyOn(runtime, "peekWorkspace").mockResolvedValue({ projectId: "p", projectDisplayName: "App", projectRootPath: main, workspaceDirectory: stale } as never);
    const out = await runtime.quotaLimitation([{ projectId: "p", workspaceId: "w" }]);
    expect(out.projects[0]?.limits[0]?.usablePercent).toBe(90);
  });
});
