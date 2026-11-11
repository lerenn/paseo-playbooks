import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AnalyticsSchema } from "./analytics";
import { PlaybookEntrySchema, ProfileInfoSchema, RunSchema, RunSummarySchema, VarValueSchema } from "./types";

export const listPlaybooks = defineRpc({
  name: "playbooks.list",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    roots: z.array(z.string()),
    exists: z.boolean(),
    entries: z.array(PlaybookEntrySchema),
    /** The workspace's project, whose profile setting applies to it. */
    projectId: z.string().default(""),
    /** Profiles of the project's main checkout, active or not. */
    profiles: z.array(ProfileInfoSchema).default([]),
    /** Layout notes (legacy folder, ambiguous ids...). */
    diagnostics: z.array(z.string()).default([]),
  }),
});

/** Turns a profile on or off for a project: the choice is the user's and applies to every workspace of the project. */
export const setProfileRpc = defineRpc({
  name: "playbooks.set-profile",
  input: z.object({ projectId: z.string(), profile: z.string(), active: z.boolean() }),
  output: z.object({ active: z.array(z.string()) }),
});

export const ProjectProfilesSchema = z.object({
  projectId: z.string(),
  label: z.string(),
  /** Profiles of the project's main checkout, active or not. `default` comes first (active unless turned off). */
  profiles: z.array(ProfileInfoSchema),
  diagnostics: z.array(z.string()).default([]),
});
export type ProjectProfiles = z.infer<typeof ProjectProfilesSchema>;

/** The given projects (each by one of its workspaces) with the profiles their main checkout offers and which are active. */
export const listProjectProfilesRpc = defineRpc({
  name: "playbooks.list-profiles",
  input: z.object({ workspaces: z.array(z.object({ projectId: z.string(), workspaceId: z.string() })) }),
  output: z.object({ projects: z.array(ProjectProfilesSchema) }),
});

/** The human restarts a project's Sidekick: the old agent is archived and a new one starts from its saved hand-off. */
export const restartSidekickRpc = defineRpc({
  name: "sidekick.restart",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ projectId: z.string(), workspaceId: z.string(), agentId: z.string(), created: z.boolean() }),
});

/** Writes the starter playbook into a workspace that has none. */
export const createExampleRpc = defineRpc({
  name: "playbooks.create-example",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ files: z.array(z.string()) }),
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

/** For the header buttons: which of these workspaces have playbooks, and which have a gate waiting. */
export const headerStateRpc = defineRpc({
  name: "header.state",
  input: z.object({ workspaceIds: z.array(z.string()) }),
  output: z.object({ withPlaybooks: z.array(z.string()), waiting: z.array(z.string()) }),
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

/** Pauses an active run (drain): no step starts and its manager is not woken until resume. */
export const pauseRunRpc = defineRpc({
  name: "runs.pause",
  input: z.object({ runId: z.string() }),
  output: z.object({ pausedAt: z.string().nullable() }),
});

/** Resumes a paused run: its manager is woken with what happened meanwhile. */
export const resumeRunRpc = defineRpc({
  name: "runs.resume",
  input: z.object({ runId: z.string() }),
  output: z.object({ pausedAt: z.string().nullable() }),
});

/** Hides a finished run from the panel. Its saved state and its agents (manager and steps) are kept. */
export const archiveRunRpc = defineRpc({
  name: "runs.archive",
  input: z.object({ runId: z.string() }),
  output: z.object({ archivedAt: z.string() }),
});

/** Starts a manual after-task of a finished run; its manager is woken to run it. */
export const startAfterTaskRpc = defineRpc({
  name: "after.start",
  input: z.object({ runId: z.string(), taskId: z.string() }),
  output: z.object({ status: z.string() }),
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

/** Reopens a finished run from a step: the step and what follows run again, with the same manager. */
export const restartRunRpc = defineRpc({
  name: "runs.restart",
  input: z.object({ runId: z.string(), stepId: z.string(), comment: z.string().optional(), hostLabel: z.string() }),
  output: z.object({ status: z.string() }),
});

/**
 * For the Playbooks screen: a summary of the runs of every workspace on this host that are not
 * archived, whatever their status. Summaries, not runs: see RunSummarySchema.
 */
export const overviewStateRpc = defineRpc({
  name: "overview.state",
  input: z.object({}),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});

/** Marks a finished run as seen (opened from the Playbooks screen). */
export const markRunSeenRpc = defineRpc({
  name: "runs.seen",
  input: z.object({ runId: z.string() }),
  output: z.object({ seenAt: z.string().nullable() }),
});

/** For the sidebar badge: how many gates wait for a human on this host. */
export const needsYouRpc = defineRpc({
  name: "overview.needs-you",
  input: z.object({}),
  output: z.object({ count: z.number().int() }),
});

/** Where the tokens went, summed over the runs on disk (archived ones too): by playbook, step, role and model. */
export const analyticsStateRpc = defineRpc({
  name: "analytics.state",
  input: z.object({ days: z.number().int().positive().optional(), playbook: z.string().optional(), projectId: z.string().optional() }),
  output: AnalyticsSchema,
});

/** One project of the Sidekick column: its Sidekick files, agent (if created) and active runs. */
export const SidekickProjectSchema = z.object({
  projectId: z.string(),
  /** A workspace of the project, to address it with. */
  workspaceId: z.string(),
  label: z.string(),
  /** The project has a `sidekick/` folder in its playbooks folder. */
  configured: z.boolean(),
  errors: z.array(z.string()),
  agentId: z.string().nullable(),
  activeRuns: z.number(),
  /** Open gates of the project's runs that wait for a human (absent from an older plugin). */
  needYou: z.number().default(0),
});
export type SidekickProject = z.infer<typeof SidekickProjectSchema>;

/** The given projects (each by one of its workspaces) with their Sidekick state. */
export const listSidekicksRpc = defineRpc({
  name: "sidekick.list",
  input: z.object({ workspaces: z.array(z.object({ projectId: z.string(), workspaceId: z.string() })) }),
  output: z.object({ projects: z.array(SidekickProjectSchema) }),
});

/** Opens a project's Sidekick: creates its hidden workspace and agent on first use, and returns the agent to chat with. */
export const openSidekickRpc = defineRpc({
  name: "sidekick.open",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ projectId: z.string(), workspaceId: z.string(), agentId: z.string(), created: z.boolean() }),
});

/** Writes the starter `sidekick/` files into the project of a workspace that has none. */
export const createSidekickFilesRpc = defineRpc({
  name: "sidekick.create-files",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ files: z.array(z.string()) }),
});

/** Saves a file pasted into the Sidekick chat on the host and returns its path (images go to the agent as image blocks instead). */
export const saveSidekickAttachmentRpc = defineRpc({
  name: "sidekick.save-attachment",
  input: z.object({ fileName: z.string().min(1), dataBase64: z.string().min(1) }),
  output: z.object({ path: z.string() }),
});
