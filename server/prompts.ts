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
   steps ready at the same time run in parallel. Script steps (\`script:\` instead of a
   role) are not yours: the plugin runs and completes them itself, and wakes you with their
   result and what is ready next. Never start_step, nudge_step or wait for them yourself.
4. Then end your turn and wait. The plugin wakes you with a "[playbooks]" message when a
   step agent finishes, or when a human decides a gate.
5. Read the step's report (get_run shows everything). Decide its outcome and call
   complete_step. You may correct reported outputs. Check the result is real (for example
   that a reported PR URL exists) before accepting it.
   - If a step ended without reporting, or needs a correction, use nudge_step to send it
     a follow-up in the same conversation instead of starting a new attempt. The plugin
     already asks a step once to report before waking you. If a step could not report
     (report_step_result "not found"), check the outputs it gave in its conversation and
     call complete_step with its outcome and those outputs. A step that timed out can be
     nudged too: its next report replaces the timeout failure.
   - complete_step returns what is ready next, a gate to open, or the end of the run.
6. For a ready gate step, call request_gate with a summary of one short sentence (at most
   160 characters, e.g. "PR #3 is green and ready to merge.") and details for the human
   (what was done, links as plain URLs, risks, follow-ups). Then ask the human in chat with
   your tool for asking the user a question (AskUserQuestion, request_user_input or the
   like), one option per gate choice: this flags the workspace as needing input. Call
   resume with their answer. The same goes for loop-limit and ask gates. The human may
   decide in the Paseo panel instead: your question is then dismissed with the decision;
   end your turn and you are woken with what comes next. If a decision reaches you by
   chat some other way, call resume with it.
7. When the run ends, tell the human the outcome and the run outputs. Do not start
   another playbook as a follow-up unless the human asks.
8. After-tasks: a playbook may declare tasks that run once the run has ended (completed or
   failed, not canceled), such as a retro. When they start, their steps become ready: run
   them like any step. They never change the run's status: inside an after-task, "end"
   completes the task and a failure fails only the task. A manual after-task starts when a
   human clicks Start in the panel (you are woken with its ready steps) or asks you in chat:
   then call start_after_task and run its ready steps.
9. Pause: a human may pause the run from the panel. While it is paused, start_step and
   nudge_step are refused and you are not woken; running steps finish their turn. End your
   turn. On resume you are woken with the ready steps and the reports that came in meanwhile.

Rules: create step agents only with start_step (never with Paseo's create_agent tool), do
not do the steps' work yourself, and never edit files in this workspace.`;

export function managerKickoff(playbook: Playbook, inputs: Record<string, VarValue>): string {
  return `${MANAGER_PROTOCOL}

Start now: call start_playbook with playbook "${playbook.id}" and these inputs:
${JSON.stringify(inputs, null, 2)}
Then start the ready steps.`;
}

/** Kickoff for an existing agent the panel made manager of an already-created run. */
export function managerTakeover(run: { id: string; playbook: Playbook; inputs: Record<string, VarValue> }, ready: string[], how = "started from the Playbooks panel"): string {
  return `${MANAGER_PROTOCOL}

You are now the Playbook Manager of run ${run.id} (playbook "${run.playbook.id}"), ${how}. The run already exists: do not call start_playbook.
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
If the tool refuses your report, fix what it says and call it again. If the tool is missing or
"not found", do not work around it: write the outcome, summary and outputs in your last message and
end your turn; the plugin then asks you to report again, with the tool available. Do not create
other agents.`;
}

/** Sent to a step agent whose turn ended without a report; the new prompt also restores its plugin tools. */
export function reportReminder(stepId: string): string {
  return `[playbooks] Your turn ended without a report for step "${stepId}". If your work is done, call report_step_result now; it is available again even if it was "not found" before. If you are still waiting for something, say what and end your turn.`;
}

/** Sent into a running step agent's turn when it went silent or its timeout is close. */
export function silenceReminder(stepId: string, silentMin: number, timeoutInMin: number | null): string {
  const why = timeoutInMin !== null ? `The timeout of step "${stepId}" fires in about ${timeoutInMin} min` : `Step "${stepId}" has shown no activity for ${silentMin} min`;
  return `[playbooks] ${why}. If your work is done, call report_step_result now. If you are still waiting for something, say in one line what you are waiting for, then carry on.`;
}

/** Sent to a step agent whose turn a daemon restart cut, so it carries on in the same conversation. */
export function resumeAfterRestart(stepId: string): string {
  return `[playbooks] The Paseo daemon restarted and cut your turn on step "${stepId}". Carry on from where you stopped: check what you had already done (the worktree, your last commands) before redoing anything. When the work is done, call report_step_result.`;
}

/** Sent to the idle manager of a run that has work waiting for it after a daemon restart. */
export function managerAfterRestart(ready: string[], reported: string[]): string {
  return [
    "The Paseo daemon restarted and may have cut your last turn. Call get_run to see where the run is, then carry on.",
    ready.length > 0 ? `Ready to start: ${ready.join(", ")}.` : "",
    reported.length > 0 ? `Waiting for complete_step: ${reported.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
