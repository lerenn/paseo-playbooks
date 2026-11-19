import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGERLESS_STEP_TOOL_NAMES, STEP_TOOL_NAMES, type Runtime } from "./runtime";
import { stepTools } from "./tools";
import { loadPlaybooks } from "./loader";
import { resolveForNewRun } from "./fresh";

vi.mock("./loader", async (original) => ({ ...await original<typeof import("./loader")>(), loadPlaybooks: vi.fn() }));
vi.mock("./fresh", async (original) => ({ ...await original<typeof import("./fresh")>(), resolveForNewRun: vi.fn() }));

const projectIdOf = vi.fn(async () => "target-project");
const runtime = { projectIdOf } as unknown as Runtime;
const agent = { id: "implementer", cwd: "/target/worktree", workspaceId: "target-workspace" };
const execute = (input: Record<string, unknown>, caller = agent) => {
  const validator = stepTools(runtime, false).find((tool) => tool.name === "validate_playbooks")!;
  return (validator.execute as (input: unknown, context: unknown) => Promise<{ isError?: boolean; structuredContent?: unknown }>)(input, { agent: caller });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadPlaybooks).mockResolvedValue({ exists: true, entries: [], sidekick: { configured: false, errors: [] } } as unknown as Awaited<ReturnType<typeof loadPlaybooks>>);
  vi.mocked(resolveForNewRun).mockResolvedValue([]);
});

describe("step tool contract", () => {
  it.each([false, true])("exposes exactly the preapproved step tools (managerless=%s)", (managerless) => {
    const names = stepTools(runtime, managerless).map((tool) => tool.name);
    expect(names).toEqual(managerless ? MANAGERLESS_STEP_TOOL_NAMES : STEP_TOOL_NAMES);
    expect(names).toEqual(managerless ? ["report_step_result", "validate_playbooks", "answer_gate"] : ["report_step_result", "validate_playbooks"]);
  });

  it.each(["implementer", "reviewer"])("uses the %s's workspace project and cwd", async (id) => {
    await execute({}, { ...agent, id });
    expect(projectIdOf).toHaveBeenCalledWith("target-workspace");
    expect(loadPlaybooks).toHaveBeenCalledWith("/target/worktree", { projectId: "target-project" });
  });

  it("overrides only the root for an explicit path, retaining the caller's profile context", async () => {
    await execute({ path: "/another/worktree" });
    expect(loadPlaybooks).toHaveBeenCalledWith("/another/worktree", { projectId: "target-project" });
    expect(resolveForNewRun).toHaveBeenCalledWith("/another/worktree", expect.anything());
    // The runtime provides only a project lookup: validation cannot mutate runs through it.
    expect(Object.keys(runtime)).toEqual(["projectIdOf"]);
  });

  it("reports an empty selection explicitly rather than inventing validation results", async () => {
    const result = await execute({});
    expect(result.structuredContent).toMatchObject({ exists: true, results: [] });
  });
});
