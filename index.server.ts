import { overviewSettings } from "./shared/overview-settings";
import path from "node:path";
import { needsReview } from "./shared/gates";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The daemon API handed to plugin handlers (typed via the SDK, so the build needs no @getpaseo/client). */
type PaseoApi = PluginHandlerContext["paseo"];
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  archiveRunRpc,
  cancelRunRpc,
  createExampleRpc,
  pauseRunRpc,
  resumeRunRpc,
  overrideQuotaRpc,
  decideGateRpc,
  deferGateRpc,
  returnGateRpc,
  headerStateRpc,
  needsYouRpc,
  overviewStateRpc,
  analyticsStateRpc,
  quotaLimitationRpc,
  listPlaybooks,
  listProjectProfilesRpc,
  setProfileRpc,
  listRuns,
  stepDetailRpc,
  listWorkspaceAgents,
  markRunSeenRpc,
  scriptOutputRpc,
  admissionStatusRpc,
  nudgeStepRpc,
  addFanoutItemRpc,
  createSidekickFilesRpc,
  listSidekicksRpc,
  openSidekickRpc,
  restartSidekickRpc,
  saveSidekickAttachmentRpc,
  restartRunRpc,
  setRunPriorityRpc,
  setRunQuotaExemptRpc,
  recoverManagerRpc,
  retryStepRpc,
  startAfterTaskRpc,
  startRun,
} from "./shared/contracts";
import { summarizeRun } from "./shared/types";
import { leanRun, stepDetail } from "./shared/lean";
import { readEventCoreConfig, setProjectProfile } from "./server/config";
import { hasPlaybooks, loadPlaybooks, projectProfiles } from "./server/loader";
import { GATE_LABEL, Runtime, STEP_LABEL, UserError } from "./server/runtime";
import { saveAttachment } from "./server/attachments";
import { SIDEKICK_LABEL } from "./server/sidekick";
import { createSidekickStarter, createStarter } from "./server/starter";
import { migrateDataDir } from "./server/data-dir";
import { defaultRunsDir, RunStore } from "./server/store";
import { deferGateTool, returnGateTool, gateTool, managerTools, resumeGateTool, runTools, sidekickStartTools, sidekickTool, stepTools, validateTool } from "./server/tools";

let safetyNet = false;
/** One bad call (a refused result, a failed timer) must not take every run's tools down: log it and keep serving. */
function installSafetyNet(): void {
  if (safetyNet) return;
  safetyNet = true;
  process.on("unhandledRejection", (reason) => console.error("[playbooks] unhandled rejection (kept serving):", reason));
  process.on("uncaughtException", (error) => console.error("[playbooks] uncaught exception (kept serving):", error));
}

export default function contribute(server: PluginServerContext) {
  installSafetyNet();
  migrateDataDir();
  // The Playbooks screen's preferences (the order of the playbooks), kept by the host.
  server.registerSettings(overviewSettings);
  // `event_core` of config.yaml is read once, at start: change it, then reload the plugin.
  const store = new RunStore(defaultRunsDir());
  const ready = readEventCoreConfig().then((eventCore) => {
    store.configure(eventCore);
    return store.init();
  });
  const runtime = new Runtime(store);

  /** Every entry point waits for the store, hands the runtime the daemon API and waits (briefly) for the runs to be picked up again, never for the sweeps or the session reload. */
  const enter = async (paseo: PaseoApi) => {
    await ready;
    await runtime.enter(paseo);
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

  // Tools: report_step_result and read-only validate_playbooks for step agents; manager tools for agents whose workspace has
  // playbooks (or that already manage a run); validate_playbooks, list_runs, cancel_run, start_after_task and
  // restart_run and recover_manager for every other agent, so a human can stop, wrap up or restart a run from any chat.
  const tools = { manager: managerTools(runtime), common: [validateTool(runtime), ...runTools(runtime), resumeGateTool(runtime), deferGateTool(runtime), returnGateTool(runtime)], step: (managerless: boolean) => stepTools(runtime, managerless), sidekick: sidekickTool(runtime), sidekickStart: sidekickStartTools(runtime), gate: gateTool(runtime) };
  server.before("agent.session_open", async ({ request }, context) => {
    if (request.purpose === "history") return;
    // Only the store is needed here. Do not wait for reconcile: its own sends (resume a step, wake a
    // manager) open sessions that land in this hook, and waiting would deadlock until the RPC timeout.
    await ready;
    void runtime.attach(context.paseo);
    await runtime.sessions.noteOpened(request.agentId);
    // A run with no manager (manager.mode: none) also gives its step agents answer_gate, to put a human gate's question in their conversation.
    if (request.labels[STEP_LABEL]) return { ...request, tools: [...request.tools, ...tools.step(runtime.isManagerlessRun(request.labels["playbooks/run"]))] };
    if (request.labels[GATE_LABEL]) return { ...request, tools: [...request.tools, tools.gate] };
    // The Sidekick sits on its project's root, which has playbooks: it gets the common tools and list_playbooks / start_playbook, never the rest of a manager's.
    if (request.labels[SIDEKICK_LABEL]) return { ...request, tools: [...request.tools, ...tools.common, ...tools.sidekickStart, tools.sidekick] };
    const manages = runtime.runsOfManager(request.agentId).length > 0 || request.labels["playbooks/manager"] === "true";
    const extra = manages || runtime.hasReservation(request.workspaceId) || (await hasPlaybooks(request.cwd)) ? tools.manager : [];
    return { ...request, tools: [...request.tools, ...tools.common, ...extra] };
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
      await runtime.onTurnEnded(agent.id, outcome.kind, agent.parentAgentId ?? null);
    }),
  );
  server.on("agent.permission_requested", ({ agent, request }, context) =>
    quietly("permission_requested", async () => {
      await enter(context.paseo);
      await runtime.onPermissionRequested({ id: agent.id, parentAgentId: agent.parentAgentId ?? null }, request);
    }),
  );
  server.on("agent.permission_resolved", ({ agent, requestId }, context) =>
    quietly("permission_resolved", async () => {
      await enter(context.paseo);
      await runtime.onPermissionResolved(agent.id, requestId);
    }),
  );
  server.on("agent.archived", ({ agent }, context) =>
    quietly("agent.archived", async () => {
      await enter(context.paseo);
      await runtime.onAgentArchived(agent.id, agent.parentAgentId);
    }),
  );
  server.on("workspace.created", () => runtime.invalidateWorkspaces());
  server.on("workspace.archived", ({ workspace }, context) =>
    quietly("workspace.archived", async () => {
      await enter(context.paseo);
      runtime.invalidateWorkspaces();
      await runtime.onWorkspaceArchived(workspace.id);
    }),
  );

  handle(listPlaybooks, async ({ workspaceId }) => {
    const workspace = await runtime.peekWorkspace(workspaceId);
    if (!workspace) throw new UserError("workspace not found");
    const loaded = await loadPlaybooks(workspace.workspaceDirectory ?? workspace.projectRootPath, { projectId: workspace.projectId });
    // The profiles on offer come from the project's main checkout, the same for every workspace of the project.
    const offered = await projectProfiles(workspace.projectRootPath, workspace.projectId);
    return { ...loaded, projectId: workspace.projectId, profiles: offered.profiles, diagnostics: [...offered.diagnostics, ...loaded.diagnostics.filter((note) => !offered.diagnostics.includes(note))] };
  });
  handle(setProfileRpc, async ({ projectId, profile, active }) => ({ active: await setProjectProfile(projectId, profile, active) }));
  handle(listProjectProfilesRpc, async ({ workspaces }) => {
    const projects = new Map<string, { projectId: string; label: string; root: string }>();
    for (const { projectId, workspaceId } of workspaces) {
      if (projects.has(projectId)) continue;
      const workspace = await runtime.peekWorkspace(workspaceId).catch(() => null);
      if (workspace) projects.set(projectId, { projectId, label: workspace.projectDisplayName || path.basename(workspace.projectRootPath), root: workspace.projectRootPath });
    }
    return { projects: await Promise.all([...projects.values()].map(async ({ projectId, label, root }) => ({ projectId, label, ...(await projectProfiles(root, projectId)) }))) };
  });
  handle(createExampleRpc, async ({ workspaceId }) => {
    const workspace = await runtime.lookupWorkspace(workspaceId);
    if (!workspace) throw new UserError("workspace not found");
    return { files: await createStarter(workspace.workspaceDirectory ?? workspace.projectRootPath) };
  });
  // Lean: the heavy text is fetched per step (stepDetailRpc) when the sheet opens. The agents' list_runs / get_run tools are unchanged.
  handle(listRuns, async ({ workspaceId }) => ({ runs: store.list().filter((run) => run.workspaceId === workspaceId && !run.archivedAt).map(leanRun) }));
  handle(stepDetailRpc, async ({ runId, stepId }) => {
    const run = store.get(runId);
    return run ? stepDetail(run, stepId) : null;
  });
  handle(archiveRunRpc, async ({ runId }) => ({ archivedAt: await runtime.archiveRun(runId) }));
  handle(startRun, (input) => runtime.startFromPanel(input));
  /** The workspaces among these whose directory has playbooks. */
  const withPlaybooksOf = async (workspaceIds: string[]) => {
    const withPlaybooks: string[] = [];
    for (const workspaceId of workspaceIds) {
      const workspace = await runtime.peekWorkspace(workspaceId).catch(() => null);
      const dir = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
      if (dir && (await hasPlaybooks(dir))) withPlaybooks.push(workspaceId);
    }
    return withPlaybooks;
  };
  handle(headerStateRpc, async ({ workspaceIds }, context) => {
    const withPlaybooks = await withPlaybooksOf(workspaceIds);
    const waiting = store
      .list()
      .filter((run) => !run.archivedAt && run.gates.some(needsReview) && workspaceIds.includes(run.workspaceId))
      .map((run) => run.workspaceId);
    return { withPlaybooks, waiting: [...new Set(waiting)] };
  });
  handle(quotaLimitationRpc, async ({ workspaces }) => runtime.quotaLimitation(workspaces));
  handle(analyticsStateRpc, async ({ days, playbook, projectId, timeZone }) => runtime.analytics({ days, playbook, projectId, timeZone }));
  handle(overviewStateRpc, async () => {
    const all = store.list();
    const priorities = await runtime.priorityViews(all);
    return { runs: all.filter((run) => !run.archivedAt).map((run) => summarizeRun(run, priorities.get(run.id) ?? null)) };
  });
  handle(admissionStatusRpc, async ({ runId }) => {
    const stages = runtime.admissionStatus(runId);
    return { stages, stations: stages };
  });
  handle(scriptOutputRpc, async ({ runId, stepId }) => runtime.scriptOutput(runId, stepId));
  handle(markRunSeenRpc, async ({ runId }) => ({ seenAt: await runtime.markSeen(runId) }));
  handle(needsYouRpc, async () => ({
    count: store.list().reduce((count, run) => count + (run.archivedAt ? 0 : run.gates.filter(needsReview).length), 0),
  }));
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
  handle(deferGateRpc, async ({ runId, gateId, reason, condition, remindAt, hostLabel }) => {
    await runtime.deferGate(runId, gateId, { reason, condition, remindAt: remindAt ?? null }, hostLabel);
    return { deferred: true };
  });
  handle(returnGateRpc, async ({ runId, gateId, note, hostLabel }) => ({ returned: await runtime.returnGate(runId, gateId, hostLabel, note?.trim() || null, "human") }));
  handle(cancelRunRpc, async ({ runId, reason }) => ({
    status: (await runtime.cancelRun(runId, reason?.trim() || "canceled from the panel", "from the panel")).status,
  }));
  handle(startAfterTaskRpc, async ({ runId, taskId }) => {
    const run = await runtime.startAfterTask(runId, taskId);
    return { status: run.after[taskId]?.status ?? "pending" };
  });
  handle(recoverManagerRpc, async ({ runId, expectedManagerId, reason, model }) => runtime.recoverManager(runId, expectedManagerId, reason, model));
  handle(restartRunRpc, async ({ runId, stepId, comment, hostLabel }) => ({
    status: (await runtime.restartRun(runId, stepId, comment?.trim() || null, hostLabel)).run.status,
  }));
  handle(setRunPriorityRpc, async ({ runId, priority, applyToChildren }) => {
    const result = await runtime.setRunPriority(runId, priority, applyToChildren, "the Quota limitation tab");
    return { priorityOverride: result.run.priorityOverride, inheritChildPriority: result.run.inheritChildPriority, from: result.from, changed: result.changed, cascaded: result.cascaded };
  });
  handle(setRunQuotaExemptRpc, async ({ runId, exempt, applyToChildren }) => {
    const result = await runtime.setRunQuotaExempt(runId, exempt, applyToChildren, "the Runs view");
    return { quotaExempt: result.run.quotaExempt, inheritChildExempt: result.run.inheritChildExempt, from: result.from, changed: result.changed, cascaded: result.cascaded };
  });
  handle(retryStepRpc, async ({ runId, stepId }) => {
    await runtime.askManagerToRetry(runId, stepId);
    return { queued: true };
  });
  handle(listSidekicksRpc, async ({ workspaces }) => ({ projects: await runtime.sidekickProjects(workspaces) }));
  handle(openSidekickRpc, ({ workspaceId }) => runtime.openSidekick(workspaceId));
  handle(restartSidekickRpc, ({ workspaceId }) => runtime.restartSidekick(workspaceId));
  handle(saveSidekickAttachmentRpc, async (input) => ({ path: await saveAttachment(input) }));
  handle(createSidekickFilesRpc, async ({ workspaceId }) => ({ files: await createSidekickStarter(await runtime.projectRootOf(workspaceId)) }));
  handle(pauseRunRpc, async ({ runId }) => ({ pausedAt: (await runtime.pauseRun(runId)).pausedAt }));
  handle(overrideQuotaRpc, async ({ provider, minutes }) => runtime.overrideQuota(provider, minutes));
  handle(resumeRunRpc, async ({ runId }) => ({ pausedAt: (await runtime.resumeRun(runId)).pausedAt }));
  handle(nudgeStepRpc, async ({ runId, stepId, message }) => {
    await runtime.nudgeStep(runId, stepId, message, true);
    return { sent: true };
  });

  handle(addFanoutItemRpc, async ({ runId, stepId, item }) => ({ key: (await runtime.addFanoutItem({ runId, stepId, item, by: null })).key }));

  return () => runtime.dispose();
}
