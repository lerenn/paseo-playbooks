import { defineAgentTool, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { GATE_SUMMARY_MAX } from "../shared/gates";
import { z } from "zod";
import type { PlaybookEntry, Run } from "../shared/types";
import { VarValueSchema } from "../shared/types";
import * as engine from "./engine";
import { loadPlaybooks } from "./loader";
import { MANAGER_PROTOCOL } from "./prompts";
import { UserError, type Runtime } from "./runtime";

function ok(text: string, structuredContent?: unknown): AgentToolResult {
  return structuredContent === undefined ? { text } : { text, structuredContent };
}

/** Turns refusals into tool errors the model can act on; unexpected errors are logged. */
async function guard(fn: () => Promise<AgentToolResult>): Promise<AgentToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof UserError) && !(error instanceof engine.EngineError)) console.error("[playbooks] tool failed:", error);
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

/** Compact run view for the manager. */
export function runSummary(run: Run) {
  return {
    runId: run.id,
    playbook: run.playbook.id,
    status: run.status,
    failure: run.failure,
    branch: run.branch,
    inputs: run.inputs,
    outputs: run.outputs,
    ready: engine.readySteps(run),
    steps: Object.fromEntries(
      run.playbook.steps.map((step) => {
        const state = run.steps[step.id]!;
        const attempt = state.attempts.at(-1);
        return [
          step.id,
          {
            kind: step.kind,
            role: step.role ?? null,
            needs: step.needs,
            outcomes: step.outcomes,
            status: state.status,
            attempts: state.attempts.length,
            agentId: attempt?.agentId ?? null,
            report: attempt?.report ?? null,
            lastMessage: attempt?.report ? null : attempt?.lastMessage ?? null,
            turnEnd: attempt?.turnEnd ?? null,
            outputs: state.outputs,
            summary: state.summary,
          },
        ];
      }),
    ),
    gates: run.gates,
    loops: run.loops,
    next: run.status === "completed" ? run.playbook.next : [],
  };
}

function describeEntry(entry: PlaybookEntry) {
  if (!entry.playbook) return { id: entry.id, file: entry.file, valid: false, errors: entry.errors };
  const pb = entry.playbook;
  return {
    id: pb.id,
    file: pb.file,
    valid: true,
    title: pb.title,
    description: pb.description,
    inputs: pb.inputs,
    outputs: Object.fromEntries(Object.entries(pb.outputs).map(([name, def]) => [name, { type: def.type, from: def.label }])),
    concurrency: pb.concurrency ?? null,
    next: pb.next.map((next) => next.playbook),
    steps: pb.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      role: step.role ? `${step.role} (${pb.roles[step.role]!.title}${pb.roles[step.role]!.readonly ? ", readonly" : ""})` : null,
      gate: step.gate ?? null,
      needs: step.needs,
      inputs: Object.fromEntries(Object.entries(step.inputs).map(([name, wiring]) => [name, `${wiring.label}${wiring.auto ? " (auto)" : ""}`])),
      outputs: Object.fromEntries(Object.entries(step.outputs).map(([name, def]) => [name, def.type])),
      outcomes: step.outcomes,
      on: step.on,
      retries: step.retries,
      agent: step.agent,
    })),
  };
}

const IdArg = z.string().describe("Run id returned by start_playbook");

export function managerTools(runtime: Runtime): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "list_playbooks",
      description: "List the playbooks of this workspace (inputs, steps, roles, validation errors) and explain how a Playbook Manager runs them.",
      input: z.object({}),
      execute: (_input, { agent }) =>
        guard(async () => {
          const loaded = await loadPlaybooks(agent.cwd);
          const playbooks = loaded.entries.map(describeEntry);
          return ok(`${MANAGER_PROTOCOL}\n\nPlaybooks:\n${JSON.stringify(playbooks, null, 2)}`, { playbooks });
        }),
    }),
    defineAgentTool({
      name: "start_playbook",
      description: "Create a run of a playbook with you as its manager, in your workspace (one active run per workspace). Returns the run id and the ready steps.",
      input: z.object({
        playbook: z.string().describe("Playbook id (its file name without .yaml)"),
        inputs: z.record(z.string(), VarValueSchema).default({}).describe("Playbook inputs by name"),
      }),
      execute: ({ playbook, inputs }, { agent }) =>
        guard(async () => {
          const run = await runtime.startPlaybook(agent, playbook, inputs);
          return ok(
            `Run ${run.id} started on branch ${run.branch ?? "(unknown)"}. Ready: ${engine.readySteps(run).join(", ")}. Start them with start_step.`,
            runSummary(run),
          );
        }),
    }),
    defineAgentTool({
      name: "start_step",
      description: "Start a ready agent step as a subagent. The plugin renders the step prompt and inputs; your brief adds context they lack.",
      input: z.object({ runId: IdArg, stepId: z.string(), brief: z.string().default("").describe("Short brief for the step agent") }),
      execute: ({ runId, stepId, brief }, { agent }) =>
        guard(async () => {
          const started = await runtime.startStep(agent.id, runId, stepId, brief);
          return ok(
            `Step "${stepId}" attempt ${started.attempt} started (agent ${started.agentId}). End your turn; you will be woken when it finishes.`,
            started,
          );
        }),
    }),
    defineAgentTool({
      name: "complete_step",
      description: "Decide the outcome of a reported step. The plugin applies the playbook's transition and returns what is ready next, a gate, or the end of the run.",
      input: z.object({
        runId: IdArg,
        stepId: z.string(),
        outcome: z.string().describe("One of the step's outcomes"),
        summary: z.string().optional().describe("Overrides the step's summary (also used as loop feedback)"),
        outputs: z.record(z.string(), VarValueSchema).optional().describe("Corrections to reported outputs"),
      }),
      execute: ({ runId, stepId, ...rest }, { agent }) =>
        guard(async () => {
          const input: { outcome: string; summary?: string; outputs?: Record<string, unknown> } = { outcome: rest.outcome };
          if (rest.summary !== undefined) input.summary = rest.summary;
          if (rest.outputs !== undefined) input.outputs = rest.outputs;
          const run = await runtime.completeStep(agent.id, runId, stepId, input);
          await runtime.clearInbox(run.id);
          const ready = engine.readySteps(run);
          const gates = ready.filter((id) => engine.stepDef(run, id).kind === "gate");
          const text =
            run.status === "completed"
              ? `Run ${run.id} completed. Outputs: ${JSON.stringify(run.outputs)}.${run.playbook.next.length ? ` Chain available: ${run.playbook.next.map((n) => n.playbook).join(", ")}.` : ""}`
              : run.status === "failed"
                ? `Run ${run.id} failed: ${run.failure}.`
                : run.status === "waiting_gate"
                  ? `A gate is waiting for a human decision. End your turn.`
                  : `Ready: ${ready.join(", ") || "none (waiting for running steps)"}.${gates.length ? ` Gate(s) to open with request_gate: ${gates.join(", ")}.` : ""}`;
          return ok(text, runSummary(run));
        }),
    }),
    defineAgentTool({
      name: "request_gate",
      description:
        "Open a ready gate step for a human: a one-sentence summary shown on the gate, and details (what was done, links, risks) shown collapsed under it. Then end your turn.",
      input: z.object({
        runId: IdArg,
        stepId: z.string(),
        summary: z
          .string()
          .max(GATE_SUMMARY_MAX, `One short sentence (at most ${GATE_SUMMARY_MAX} characters); put everything else in details`)
          .describe(`One short sentence (at most ${GATE_SUMMARY_MAX} characters): what the human decides, e.g. "PR #3 is green and ready to merge."`),
        details: z.string().default("").describe("What was done, links, risks, follow-ups (collapsed under the summary)"),
      }),
      execute: ({ runId, stepId, summary, details }, { agent }) =>
        guard(async () => {
          const gate = await runtime.requestGate(agent.id, runId, stepId, summary, details);
          return ok(`Gate ${gate.id} is open in the Paseo panel. Tell the human, then end your turn.`, gate);
        }),
    }),
    defineAgentTool({
      name: "resume",
      description: "Record a gate decision that reached you by chat (e.g. a Slack reply). If the panel already decided, returns that decision.",
      input: z.object({
        runId: IdArg,
        stepId: z.string().describe("Gate step id or gate id"),
        decision: z.string().describe('One of the gate\'s choices (by default "approved" or "rejected")'),
        comment: z.string().optional(),
        decidedBy: z.string().optional().describe("Who decided, e.g. a Slack user id"),
      }),
      execute: ({ runId, stepId, decision, comment, decidedBy }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          const result = await runtime.decideGate(runId, stepId, {
            decision,
            comment: comment ?? null,
            by: decidedBy ?? null,
            via: "chat",
            now: new Date().toISOString(),
          });
          const run = (await runtime.ownedRun(agent.id, runId))!;
          const prefix = result.alreadyDecided ? `Already decided: ${result.gate.status} via ${result.gate.decidedVia}.` : `Recorded ${decision}.`;
          return ok(`${prefix} Run is ${run.status}. Ready: ${engine.readySteps(run).join(", ") || "none"}.`, runSummary(run));
        }),
    }),
    defineAgentTool({
      name: "nudge_step",
      description: "Send a follow-up message to a step's current agent (same conversation, no new attempt), e.g. when it ended without reporting.",
      input: z.object({ runId: IdArg, stepId: z.string(), message: z.string() }),
      execute: ({ runId, stepId, message }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          await runtime.nudgeStep(runId, stepId, message);
          return ok(`Sent to "${stepId}". End your turn; you will be woken when it finishes.`);
        }),
    }),
    defineAgentTool({
      name: "get_run",
      description: "Show a run's state: steps, reports, outputs, gates, loops. Without runId, your active (or latest) run.",
      input: z.object({ runId: IdArg.optional() }),
      execute: ({ runId }, { agent }) =>
        guard(async () => {
          const run = runtime.ownedRun(agent.id, runId);
          await runtime.clearInbox(run.id);
          const summary = runSummary(run);
          return ok(JSON.stringify(summary, null, 2), summary);
        }),
    }),
    defineAgentTool({
      name: "cancel_run",
      description: "Cancel a run and stop its running step agents.",
      input: z.object({ runId: IdArg, reason: z.string() }),
      execute: ({ runId, reason }, { agent }) =>
        guard(async () => {
          runtime.ownedRun(agent.id, runId);
          const run = await runtime.cancelRun(runId, reason, false);
          return ok(`Run ${run.id} canceled.`, runSummary(run));
        }),
    }),
  ];
}

export function validateTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "validate_playbooks",
    description:
      "Validate the playbooks in <workspace>/.paseo/plugins/playbooks/ and <workspace>/.paseo/playbooks/ (or in the given workspace folder) with the same checks as the Playbooks panel. Writes nothing.",
    input: z.object({ path: z.string().optional().describe("Workspace folder to check; defaults to yours") }),
    execute: ({ path }, { agent }) =>
      guard(async () => {
        const loaded = await loadPlaybooks(path ?? agent.cwd);
        if (!loaded.exists) return ok(`No playbooks folder: create .paseo/plugins/playbooks/ or .paseo/playbooks/ in ${path ?? agent.cwd}.`, { exists: false });
        const results = loaded.entries.map(describeEntry);
        const invalid = results.filter((result) => !result.valid).length;
        const head = loaded.entries.length === 0 ? "No playbook files found." : invalid === 0 ? `All ${results.length} playbook(s) are valid.` : `${invalid} of ${results.length} playbook(s) have errors.`;
        return ok(`${head}\n${JSON.stringify(results, null, 2)}`, { exists: true, results });
      }),
  });
}

export function stepTool(runtime: Runtime): AgentToolDefinition {
  return defineAgentTool({
    name: "report_step_result",
    description: "Report this playbook step's result. Call exactly once, as your last action. Refused (with the reason) if outputs are missing or mistyped.",
    input: z.object({
      outcome: z.string().describe("One of the outcomes listed in your instructions"),
      summary: z.string().describe("What you did and found"),
      outputs: z.record(z.string(), VarValueSchema).default({}).describe("Declared outputs by name"),
    }),
    execute: (report, { agent }) =>
      guard(async () => {
        const stepId = await runtime.report(agent.id, report);
        return ok(`Report for "${stepId}" recorded. Stop here: end your turn.`);
      }),
  });
}
