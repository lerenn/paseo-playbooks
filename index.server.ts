import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  archiveRunRpc,
  cancelRunRpc,
  decideGateRpc,
  listPlaybooks,
  listRuns,
  listWorkspaceAgents,
  nudgeStepRpc,
  retryStepRpc,
  startRun,
} from "./shared/contracts";
import { capSettings, DEFAULT_CAP } from "./shared/settings";
import { hasPlaybooks, loadPlaybooks } from "./server/loader";
import { Runtime, STEP_LABEL, UserError } from "./server/runtime";
import { defaultRunsDir, RunStore } from "./server/store";
import { managerTools, stepTool, validateTool } from "./server/tools";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(capSettings);
  const store = new RunStore(defaultRunsDir());
  const ready = store.init();
  const runtime = new Runtime(store, async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : DEFAULT_CAP;
  });

  /** Every entry point waits for the store and hands the runtime the daemon API. */
  const enter = async (paseo: PaseoApi) => {
    await ready;
    await runtime.attach(paseo);
  };
  const quietly = (label: string, fn: () => Promise<void>) =>
    fn().catch((error) => console.error(`[playbooks] ${label} failed:`, error));
  const handle: PluginServerContext["handle"] = (contract, handler) =>
    server.handle(contract, async (input, context) => {
      await enter(context.paseo);
      try {
        return await handler(input, context);
      } catch (error) {
        if (!(error instanceof UserError)) console.error(`[playbooks] ${contract.name} failed:`, error);
        throw error;
      }
    });

  // Tools: report_step_result for step agents; manager tools for agents whose workspace has
  // playbooks (or that already manage a run); validate_playbooks for every other agent.
  const tools = { manager: managerTools(runtime), validate: validateTool(runtime), step: stepTool(runtime) };
  server.before("agent.session_open", async ({ request }, context) => {
    if (request.purpose === "history") return;
    await enter(context.paseo);
    if (request.labels[STEP_LABEL]) return { ...request, tools: [...request.tools, tools.step] };
    const manages = runtime.runsOfManager(request.agentId).length > 0 || request.labels["playbooks/manager"] === "true";
    const extra = manages || runtime.hasReservation(request.workspaceId) || (await hasPlaybooks(request.cwd)) ? tools.manager : [];
    return { ...request, tools: [...request.tools, tools.validate, ...extra] };
  });

  server.on("agent.turn_started", ({ agent }, context) =>
    quietly("turn_started", async () => {
      await enter(context.paseo);
      runtime.onTurnStarted(agent.id);
    }),
  );
  server.on("agent.turn_ended", ({ agent, outcome }, context) =>
    quietly("turn_ended", async () => {
      await enter(context.paseo);
      await runtime.onTurnEnded(agent.id, outcome.kind);
    }),
  );
  server.on("agent.archived", ({ agent }, context) =>
    quietly("agent.archived", async () => {
      await enter(context.paseo);
      await runtime.onAgentArchived(agent.id);
    }),
  );
  server.on("workspace.archived", ({ workspace }, context) =>
    quietly("workspace.archived", async () => {
      await enter(context.paseo);
      await runtime.onWorkspaceArchived(workspace.id);
    }),
  );

  handle(listPlaybooks, async ({ workspaceId }, { paseo }) => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new UserError("workspace not found");
    return loadPlaybooks(workspace.workspaceDirectory ?? workspace.projectRootPath, await runtime.cap());
  });
  handle(listRuns, async ({ workspaceId }) => ({ runs: store.list().filter((run) => run.workspaceId === workspaceId && !run.archivedAt) }));
  handle(archiveRunRpc, async ({ runId }) => ({ archivedAt: await runtime.archiveRun(runId) }));
  handle(startRun, (input) => runtime.startFromPanel(input));
  handle(listWorkspaceAgents, async ({ workspaceId }) => ({ agents: await runtime.workspaceAgents(workspaceId) }));
  handle(decideGateRpc, async ({ runId, gateId, decision, comment, hostLabel }) => {
    const result = await runtime.decideGate(runId, gateId, {
      decision,
      comment: comment?.trim() || null,
      by: hostLabel,
      via: "panel",
      now: new Date().toISOString(),
    });
    return { alreadyDecided: result.alreadyDecided, decision: result.gate.status };
  });
  handle(cancelRunRpc, async ({ runId, reason }) => ({
    status: (await runtime.cancelRun(runId, reason?.trim() || "canceled from the panel", true)).status,
  }));
  handle(retryStepRpc, async ({ runId, stepId }) => {
    await runtime.askManagerToRetry(runId, stepId);
    return { queued: true };
  });
  handle(nudgeStepRpc, async ({ runId, stepId, message }) => {
    await runtime.nudgeStep(runId, stepId, message);
    return { sent: true };
  });

  return () => runtime.dispose();
}
