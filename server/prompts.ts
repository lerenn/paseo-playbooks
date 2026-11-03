import type { Playbook, Role, Step, VarValue } from "../shared/types";

/** How the manager works. Returned by list_playbooks and sent when Start creates a manager. */
export const MANAGER_PROTOCOL = `You are the Playbook Manager. You run a playbook by starting each step as a subagent,
briefing it, reading its result and deciding its outcome. The paseo-playbooks plugin owns
the rules: it refuses any step or transition the playbook does not allow.

How to run a playbook:
1. list_playbooks shows the playbooks of this workspace, their inputs and steps.
2. start_playbook creates the run in your workspace (one active run per workspace). It
   returns the ready steps.
3. For each ready agent step, call start_step with a short brief: what matters from the
   request and earlier results that the step prompt does not already say. The plugin
   renders the step's prompt and inputs; do not repeat them. Start every ready step;
   steps ready at the same time run in parallel.
4. Then end your turn and wait. The plugin wakes you with a "[playbooks]" message when a
   step agent finishes, or when a human decides a gate.
5. Read the step's report (get_run shows everything). Decide its outcome and call
   complete_step. You may correct reported outputs. Check the result is real (for example
   that a reported PR URL exists) before accepting it.
   - If a step ended without reporting, or needs a correction, use nudge_step to send it
     a follow-up in the same conversation instead of starting a new attempt.
   - complete_step returns what is ready next, a gate to open, or the end of the run.
6. For a ready gate step, call request_gate with a summary of one short sentence (at most
   160 characters, e.g. "PR #3 is green and ready to merge.") and details for the human
   (what was done, links as plain URLs, risks, follow-ups), then end your turn. The human approves or rejects in the Paseo
   panel; you are woken with the decision. If a decision reaches you by chat instead,
   call resume with it.
7. When the run ends, tell the human the outcome and the run outputs. Do not start
   another playbook as a follow-up unless the human asks.
8. After-tasks: a playbook may declare tasks that run once the run has ended (completed or
   failed, not canceled), such as a retro. When they start, their steps become ready: run
   them like any step. They never change the run's status: inside an after-task, "end"
   completes the task and a failure fails only the task. A human may also start a manual
   after-task from the panel later; you are woken with its ready steps.

Rules: create step agents only with start_step (never with Paseo's create_agent tool), do
not do the steps' work yourself, and never edit files in this workspace.`;

export function managerKickoff(playbook: Playbook, inputs: Record<string, VarValue>): string {
  return `${MANAGER_PROTOCOL}

Start now: call start_playbook with playbook "${playbook.id}" and these inputs:
${JSON.stringify(inputs, null, 2)}
Then start the ready steps.`;
}

/** Kickoff for an existing agent the panel made manager of an already-created run. */
export function managerTakeover(run: { id: string; playbook: Playbook; inputs: Record<string, VarValue> }, ready: string[]): string {
  return `${MANAGER_PROTOCOL}

You are now the Playbook Manager of run ${run.id} (playbook "${run.playbook.id}"), started from the Playbooks panel. The run already exists: do not call start_playbook.
Inputs:
${JSON.stringify(run.inputs, null, 2)}
Ready now: ${ready.join(", ") || "none"}. Start them with start_step.`;
}

function describeOutputs(step: Step): string {
  const entries = Object.entries(step.outputs);
  if (entries.length === 0) return "This step declares no outputs; pass `outputs: {}`.";
  return [
    "Required outputs (all of them, with these types):",
    ...entries.map(([name, def]) => {
      const type = def.type === "enum" ? `one of ${(def.values ?? []).join(" | ")}` : def.type;
      return `- ${name}: ${type}${def.description ? ` — ${def.description}` : ""}`;
    }),
  ].join("\n");
}

/** System prompt for a step agent: role instructions plus the step protocol. */
export function stepSystemPrompt(playbook: Playbook, step: Step, role: Role): string {
  const readonly = role.readonly
    ? `\n\nThis role is READONLY: do not edit, create or delete tracked files, do not commit and do not switch branches. The plugin checks the checkout when you finish and fails the step if anything changed. Build output in ignored files is fine.`
    : "";
  return `${role.instructions}${readonly}

You are running step "${step.id}" (${role.title}) of the playbook "${playbook.title}", started by a
Playbook Manager agent. Other steps may share this checkout.

When you are done, call the report_step_result tool exactly once, as your last action:
- outcome: one of ${step.outcomes.map((outcome) => `"${outcome}"`).join(", ")}${step.outcomes.includes("failure") ? ' (use "failure" if you could not do the work)' : ""}
- summary: what you did and found, for the manager and the next steps
- outputs: ${describeOutputs(step)}
If the tool refuses your report, fix what it says and call it again. Do not create other agents.`;
}
