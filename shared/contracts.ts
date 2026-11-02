import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { PlaybookEntrySchema, RunSchema, VarValueSchema } from "./types";

export const listPlaybooks = defineRpc({
  name: "playbooks.list",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    roots: z.array(z.string()),
    exists: z.boolean(),
    entries: z.array(PlaybookEntrySchema),
  }),
});

export const listRuns = defineRpc({
  name: "runs.list",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ runs: z.array(RunSchema) }),
});

export const startRun = defineRpc({
  name: "runs.start",
  input: z.object({
    workspaceId: z.string(),
    playbook: z.string(),
    inputs: z.record(z.string(), VarValueSchema),
    /** Start even when an active run of this playbook has the same inputs. */
    force: z.boolean().default(false),
    /** Manage the run with this agent of the workspace. */
    agentId: z.string().optional(),
    /** Without agentId: true = a new manager agent in this workspace; false = a new worktree with a new manager. */
    sameWorkspace: z.boolean().default(false),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("started"),
      workspaceId: z.string(),
      managerAgentId: z.string(),
      runId: z.string(),
      /** The agent was busy: it receives the kickoff when its current turn ends. */
      queued: z.boolean().default(false),
    }),
    z.object({ status: z.literal("duplicate"), runId: z.string(), message: z.string() }),
  ]),
});

/** Agents of a workspace that can manage a run (step agents excluded), most recent first. */
export const listWorkspaceAgents = defineRpc({
  name: "agents.list",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    agents: z.array(
      z.object({ id: z.string(), title: z.string().nullable(), provider: z.string(), status: z.string(), managing: z.string().nullable() }),
    ),
  }),
});

export const decideGateRpc = defineRpc({
  name: "gates.decide",
  input: z.object({
    runId: z.string(),
    gateId: z.string(),
    /** A choice id of the gate ("approved" / "rejected" by default). */
    decision: z.string(),
    comment: z.string().optional(),
    hostLabel: z.string(),
  }),
  output: z.object({ alreadyDecided: z.boolean(), decision: z.string() }),
});

export const cancelRunRpc = defineRpc({
  name: "runs.cancel",
  input: z.object({ runId: z.string(), reason: z.string().optional() }),
  output: z.object({ status: z.string() }),
});

/** Hides a finished run from the panel. Its saved state and its agents (manager and steps) are kept. */
export const archiveRunRpc = defineRpc({
  name: "runs.archive",
  input: z.object({ runId: z.string() }),
  output: z.object({ archivedAt: z.string() }),
});

export const retryStepRpc = defineRpc({
  name: "steps.retry",
  input: z.object({ runId: z.string(), stepId: z.string() }),
  output: z.object({ queued: z.boolean() }),
});

export const nudgeStepRpc = defineRpc({
  name: "steps.nudge",
  input: z.object({ runId: z.string(), stepId: z.string(), message: z.string().min(1) }),
  output: z.object({ sent: z.boolean() }),
});
