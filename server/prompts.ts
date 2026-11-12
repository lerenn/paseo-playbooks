import type { Gate, GateChoice, Playbook, Role, Run, Step, VarValue } from "../shared/types";
import { jobsText } from "./engine";
import { replaceRefs } from "../shared/vars";

/** How the manager works. Returned by list_playbooks and sent when Start creates a manager. */
export const MANAGER_PROTOCOL = `You are the Playbook Manager. You run a playbook by starting each step as a subagent,
briefing it, reading its result and deciding its outcome. The paseo-playbooks plugin owns
the rules: it refuses any step or transition the playbook does not allow.

How to run a playbook:
1. list_playbooks shows the playbooks of this workspace, their inputs and steps.
2. start_playbook creates the run in your workspace (one active run per workspace, unless the playbook
   is isolated: its runs work in private git worktrees and may share a workspace). It
   returns the ready steps and, unless you pass autoStart: false, has already started the ready agent
   steps (as start_step would, with no brief): start only the ready steps it says were not started. Give it a name: 2 to 4 words saying what this run is about
   (e.g. "login-redirect-fix"), so humans can tell runs apart in the panel.
3. For each ready agent step, call start_step with a short brief: what matters from the
   request and earlier results that the step prompt does not already say. The plugin
   renders the step's prompt and inputs; do not repeat them. Start every ready step;
   steps ready at the same time run in parallel. Script steps (\`script:\` instead of a
   role) are not yours: the plugin runs and completes them itself, and wakes you with their
   result and what is ready next. Never start_step, nudge_step or wait for them yourself.
4. Then end your turn and wait. The plugin wakes you with a "[playbooks]" message when a
   step agent finishes, or when a human decides a gate.
5. Read the step's report: the "[playbooks]" message carries it. get_run shows each step's
   state in short; get_run with view "full" (and steps: [its id]) shows the full report and
   outputs. Decide its outcome and call complete_step. You may correct reported outputs. Check the result is real (for example
   that a reported PR URL exists) before accepting it.
   - If a step ended without reporting, or needs a correction, use nudge_step to send it
     a follow-up in the same conversation instead of starting a new attempt. The plugin
     already asks a step once to report before waking you. If a step could not report
     (report_step_result "not found"), check the outputs it gave in its conversation and
     call complete_step with its outcome and those outputs. A step that timed out can be
     nudged too: its next report replaces the timeout failure.
   - If a step stopped because its provider is out of tokens (the plugin says so, or its last
     message reads "usage limit", "weekly limit", "rate limit"...), the plugin has already
     moved it to any fallback it had. Otherwise move it yourself: nudge_step with model (a
     provider/model from list_models) gives the same attempt a new agent on that model, no
     retry used. start_step and restart_run take model too, for one attempt. Pass model only
     for such a case or when the human asks; never by default.
   - A step with \`role.completion.auto\` (get_run shows its autoComplete outcomes) has some outcomes the plugin applies
     itself: when its agent reports one, the plugin completes the step with that report, starts the agent
     and script steps that become ready, and only adds a line to your inbox: you are not woken for it and
     must not call complete_step for it (it is refused). Any other outcome, every failure, and any case where
     a gate, a hand-off, a fan-out or the end of the run would come next, stays reported and wakes you as usual.
   - complete_step returns what changed (the step's new status, what is ready next, open
     gates, or the end of the run), not the whole run.
6. For a ready gate step, call request_gate with a summary of one short sentence (at most
   160 characters, e.g. "PR #3 is green and ready to merge.") and details for the human
   (what was done, links as plain URLs, risks, follow-ups). Then ask the human in chat with
   your tool for asking the user a question (AskUserQuestion, request_user_input or the
   like), one option per gate choice: this flags the workspace as needing input. Call
   resume with their answer. The same goes for loop-limit and ask gates. The human may
   decide in the Paseo panel instead: your question is then dismissed with the decision;
   end your turn and you are woken with what comes next. If a decision reaches you by
   chat some other way, call resume with it.
   A gate may name another decider; each gate's message says which. With the manager as
   decider, decide it yourself when the run gives you enough (resume with byManager: true
   and your reason as comment), or call escalate_gate with your reason and ask a human as above. With a role as decider, the plugin
   starts an agent that decides it or leaves it to a human: do not ask and do not call
   resume, end your turn; you are woken with its decision, or told to ask a human. Never
   decide a gate without byManager unless a human gave you the answer.
7. When the run ends, tell the human the outcome and the run outputs. Do not start
   another playbook as a follow-up unless the human asks.
8. After-tasks: a playbook may declare tasks that run once the run has ended (completed or
   failed, not canceled), such as a retro. When they start, their steps become ready: run
   them like any step. They never change the run's status: inside an after-task, "end"
   completes the task and a failure fails only the task. A manual after-task starts when a
   human clicks Start in the panel (you are woken with its ready steps) or asks you in chat:
   then call start_after_task and run its ready steps. A step that reviews the run (a retro)
   needs the whole run: get_run with view "full" gives it.
9. Fan-out steps (\`fanout:\`) are not yours either: the plugin starts one run of a playbook per
   item of a list, each in its own workspace with its own manager, keeps at most max_active of
   them going, and wakes you when every one has ended (outcome all_completed or some_failed,
   with per-item results in the outputs). Never start_step or complete_step it, and never
   touch the child runs: their gates go to the human in the Playbooks panel.
   Hand-off steps (\`handoff:\` instead of a role) are not yours either: a hand-off gives the task
   to a singleton playbook. The plugin hands the job to its pipeline and the step completes at
   once, with no outputs; the run goes on with what is ready next (often it ends there). You are
   never told how the job ends and never involved with it afterwards.
10. Pause: a human may pause the run from the panel. While it is paused, start_step and
   nudge_step are refused and you are not woken; running steps finish their turn. End your
   turn. On resume you are woken with the ready steps and the reports that came in meanwhile.

11. Overseeing: get_run reads any run, not only yours (writes stay with the run's manager).
   list_gates shows every open gate and ask across runs and who holds each; with
   includeFailed it adds failed runs and runs that lost their manager. subscribe_events
   asks the plugin to message you on events (held until your turn ends unless delivery is "steer") (types such as gate.opened, gate.stale,
   gate.decided, run.failed, run.manager_lost, step.started, step.completed, step.slow, run.completed, run.canceled; globs like "gate.*" work) and list_events
   replays what you missed: use them only when a human asks you to watch the runs. None of this lets you
   decide another run's gate.

Rules: create step agents only with start_step (never with Paseo's create_agent tool), do
not do the steps' work yourself, and never edit files in this workspace.`;

/** Staging rule given to every step agent: a blanket add in a worktree with empty submodule directories stages their deletion. */
export const GIT_STAGING_RULE = `Never run \`git add -A\`, \`git add .\` or \`git commit -a\`/\`-am\`: stage files explicitly by path (\`git add <path>\`) and check \`git diff --cached --stat\` before committing. Never stage the removal of a submodule entry (mode 160000): in a worktree where submodule directories are empty or absent a blanket add stages their deletion; if \`git diff --cached --summary\` shows \`delete mode 160000\`, run \`git restore --staged\` on it before committing.`;

/**
 * What every agent of an isolated run is told first: it works in the run's private git worktree, never
 * in the workspace checkout it was started in (Paseo pins an agent's directory to its workspace).
 */
export function worktreePreamble(run: Pick<Run, "worktree" | "workspaceDir">): string {
  const wt = run.worktree;
  if (!wt) return "";
  const subs = wt.linked.length > 0 ? ` Submodules linked there: ${wt.linked.join(", ")}.` : "";
  return `ISOLATED RUN. This run works ONLY in its own git worktree: ${wt.path} (branch ${wt.branch}, created from ${wt.base}).${subs}
Your shell starts in ${run.workspaceDir}, the original workspace checkout: do not use it.
- Run every command from the worktree: \`cd ${wt.path} && <command>\` in the same command, or \`git -C ${wt.path} ...\`; the shell resets to the workspace directory between commands, so a bare \`cd\` does not stick.
- Use absolute paths under ${wt.path} for Read, Edit and Write. A relative path in your instructions means a path inside the worktree.
- Never edit, create or delete files in ${run.workspaceDir}, and never commit there or switch its branch. Never run \`git checkout\`, \`git reset\` or \`git pull\` in it. The plugin checks that checkout when you finish and fails the step if it changed.
- Never use \`git stash\`: the stash stack is shared with the original checkout and every other worktree, so you could take or bury someone else's changes. Set work aside with a temporary WIP commit on the run's branch instead.
- ${GIT_STAGING_RULE} The plugin also fails a step whose branch deletes a submodule entry.
- A submodule directory that is empty in the worktree is not initialised: run \`git -C ${wt.path} submodule update --init -- <path>\` for the ones you need.`;
}

/** Puts the run's worktree path where a prompt or instruction writes {{ worktree }}; the other placeholders stay. */
export function withWorktree(text: string, run: Pick<Run, "worktree" | "workspaceDir">): string {
  return replaceRefs(text, (ref) => (ref === "worktree" ? (run.worktree?.path ?? run.workspaceDir) : null));
}

/** `text` led by the isolation preamble when the run is isolated. */
export function withPreamble(text: string, run: Pick<Run, "worktree" | "workspaceDir">): string {
  const preamble = worktreePreamble(run);
  return preamble ? `${preamble}\n\n${text}` : text;
}

/** The repository's and the playbooks' added instructions for the manager, or "" when there are none. */
export function managerInstructionsText(playbook: Playbook): string {
  const list = playbook.managerInstructions ?? [];
  if (list.length === 0) return "";
  const entries = list.map((entry) => `- ${entry.playbook ?? "repository"}: ${entry.text.replace(/\n/g, "\n  ")}`);
  return `Instructions for this run (they add to the rules above, never replace them):\n${entries.join("\n")}`;
}

/** `text` followed by the manager instructions, if any. */
function withInstructions(text: string, playbook: Playbook): string {
  const instructions = managerInstructionsText(playbook);
  return instructions ? `${text}\n\n${instructions}` : text;
}

/** Told to a manager before its run exists: start_playbook creates the worktree and returns its path. */
function isolationNote(playbook: Playbook): string {
  return playbook.isolation.mode === "worktree"
    ? `\nThis playbook runs ISOLATED: start_playbook creates a private git worktree for the run and returns its path. Any command of yours that reads the repository runs from there (\`cd <worktree> && ...\` or \`git -C <worktree> ...\`), never from your workspace checkout, which stays untouched.\n`
    : "";
}

export function managerKickoff(playbook: Playbook, inputs: Record<string, VarValue>, autoStart = true): string {
  return `${MANAGER_PROTOCOL}
${isolationNote(playbook)}
Start now: call start_playbook with playbook "${playbook.id}"${autoStart ? "" : ", autoStart: false,"} and these inputs:
${JSON.stringify(inputs, null, 2)}
${autoStart ? "start_playbook starts the ready agent steps itself: do not start_step them again; start only the ready steps it reports as not started." : "Then end your turn: leave the ready steps unstarted until you are told to start them."}`;
}

/** Kickoff for an existing agent the panel made manager of an already-created run. */
export function managerTakeover(run: { id: string; playbook: Playbook; inputs: Record<string, VarValue>; worktree?: Run["worktree"]; workspaceDir?: string }, ready: string[], how = "started from the Playbooks panel"): string {
  return `${withInstructions(MANAGER_PROTOCOL, run.playbook)}
${run.worktree ? `\n${worktreePreamble({ worktree: run.worktree, workspaceDir: run.workspaceDir ?? "the workspace" })}\n` : ""}
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
export function stepSystemPrompt(playbook: Playbook, step: Step, role: Role, run?: Pick<Run, "worktree" | "workspaceDir">): string {
  const managerless = playbook.managerMode === "none";
  const readonly = role.readonly
    ? `\n\nThis role is READONLY: do not edit, create or delete tracked files, do not commit and do not switch branches. The plugin checks the checkout when you finish and fails the step if anything changed. Build output in ignored files is fine.`
    : "";
  const instructions = run ? withWorktree(role.instructions, run) : role.instructions;
  const preamble = run ? worktreePreamble(run) : "";
  const staging = preamble ? "" : `\n\n${GIT_STAGING_RULE}`;
  return `${preamble ? `${preamble}\n\n` : ""}${instructions}${readonly}${staging}

You are running step "${step.id}" (${role.title}) of the playbook "${playbook.title}", started by ${managerless ? "the playbooks plugin (this run has no Playbook Manager)" : "a\nPlaybook Manager agent"}. Other steps may share this checkout.

When you are done, call the report_step_result tool exactly once, as your last action:
- outcome: one of ${step.outcomes.map((outcome) => `"${outcome}"`).join(", ")}${step.outcomes.includes("failure") ? ' (use "failure" if you could not do the work)' : ""}
- summary: what you did and found, for ${managerless ? "the human and " : "the manager and "}the next steps
- outputs: ${describeOutputs(step)}
${managerless ? "There is no manager and nobody to call: the plugin applies the outcome you report as soon as your turn ends and starts what follows. Report exactly the outcome you mean and stop. A failure stops the run unless the playbook retries it.\n" : ""}${!managerless && step.autoComplete?.length ? `The plugin applies ${step.autoComplete.map((outcome) => `"${outcome}"`).join(", ")} itself as soon as you report it, so report exactly the outcome you mean: there is no manager review of it. Any other outcome goes to the manager.\n` : ""}If the tool refuses your report, fix what it says and call it again. If the tool is missing or
"not found", do not work around it: write the outcome, summary and outputs in your last message and
end your turn; the plugin then asks you to report again, with the tool available. Do not create
other agents.
If you must wait for something (CI, a review, a deploy), wait inside your turn with a bounded
foreground poll (a command that checks, sleeps and returns when done or after a time limit), then
report. Never end your turn to wait on a Monitor, a background command or a timer: you may not be
woken again.`;
}

/** System prompt for a gate's role decider: role instructions plus the decider protocol. */
export function gateDeciderSystemPrompt(playbook: Playbook, gate: Gate, role: Role, choices: GateChoice[], run?: Pick<Run, "worktree" | "workspaceDir">): string {
  const preamble = run ? worktreePreamble(run) : "";
  return `${preamble ? `${preamble}\n\n` : ""}${run ? withWorktree(role.instructions, run) : role.instructions}

This role is READONLY: do not edit, create or delete tracked files, do not commit and do not switch branches.

You decide gate "${gate.id}" (step "${gate.stepId}") of the playbook "${playbook.title}" in place of a human,
when your instructions allow it. Otherwise leave it to a human: that is always allowed.

When you are done, call the report_gate_decision tool exactly once, as your last action:
- decision: one of ${choices.map((choice) => `"${choice.id}"`).join(", ")}, or "escalate" to leave the gate to a human
- comment: your reason, in one or two sentences; a human reads it with the decision
If the tool refuses your decision, fix what it says and call it again. Do not create other agents, and do
not end your turn without calling it.`;
}

/** First message of a gate's role decider: the gate, its choices, and what the run did so far. */
export function gateDeciderPrompt(run: Run, gate: Gate, choices: GateChoice[]): string {
  const done = run.playbook.steps.filter((step) => run.steps[step.id]?.status === "completed" || step.id === gate.stepId);
  const steps = done
    .map((step) => {
      const state = run.steps[step.id]!;
      const outputs = Object.keys(state.outputs).length > 0 ? `\n  outputs: ${JSON.stringify(state.outputs)}` : "";
      return `- ${step.id} (${state.status}): ${state.summary ?? "(no summary)"}${outputs}`;
    })
    .join("\n");
  return [
    `Gate ${gate.id}: ${gate.summary || gate.message}`,
    gate.details ? `Details:\n${gate.details}` : "",
    `Choices:\n${choices.map((choice) => `- "${choice.id}": ${choice.label}${choice.comment === "required" ? " (needs a comment)" : ""}`).join("\n")}`,
    `Run inputs:\n${JSON.stringify(run.inputs, null, 2)}`,
    steps ? `Steps so far:\n${steps}` : "",
    "Decide, or escalate, with report_gate_decision.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Sent to a role decider whose turn ended without a decision. */
export function gateDecisionReminder(gateId: string): string {
  return `[playbooks] Your turn ended without a decision for gate "${gateId}". Call report_gate_decision now, with one of the gate's choices or "escalate", and your reason as comment.`;
}

/** Sent to the step agent that precedes a human gate of a run with no manager: it asks the human in its own conversation. */
export function gateChatPrompt(runId: string, gate: Gate, choices: GateChoice[]): string {
  const list = choices.map((choice) => `- "${choice.id}": ${choice.label}${choice.comment === "required" ? " (ask for a comment too)" : ""}`).join("\n");
  return `[playbooks] ${runId} reached gate "${gate.id}" and a human must decide it. Ask the human now with the AskUserQuestion tool, one question with one option per choice, then call answer_gate with the id of the choice they pick and their comment (gateId "${gate.id}").

Question: ${gate.summary || gate.message}${gate.details ? `\n\nDetails:\n${gate.details}` : ""}

Choices:\n${list}

The human may decide in the Playbooks panel instead: your question is then closed and answer_gate says so; end your turn. Do nothing else (no step work, no other tool).`;
}

/** Sent to a step agent whose turn ended without a report; the new prompt also restores its plugin tools. */
export function reportReminder(stepId: string): string {
  return `[playbooks] Your turn ended without a report for step "${stepId}". If your work is done, call report_step_result now; it is available again even if it was "not found" before. If you are still waiting for something, keep waiting in this turn with a bounded foreground poll (not a Monitor, background command or timer), then call report_step_result.`;
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
    "The Paseo daemon restarted and may have cut your last turn. Call get_run to see where the run is (view \"full\" for the reports), then carry on.",
    ready.length > 0 ? `Ready to start: ${ready.join(", ")}.` : "",
    reported.length > 0 ? `Waiting for complete_step: ${reported.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Kickoff for the manager of a batch: one run of a singleton pipeline's stage, carrying jobs. */
export function singletonKickoff(run: Run, ready: string[]): string {
  const jobs = jobsText(run);
  return `${withInstructions(MANAGER_PROTOCOL, run.playbook)}

You are the Playbook Manager of run ${run.id}: a batch of stage "${run.batch?.stage ?? "?"}" of the singleton
pipeline "${run.batch?.playbook ?? run.playbook.id}", in the pipeline's shared workspace. The run already exists: do not
call start_playbook for it. To start another playbook (for example rework for a job you eject), call
start_playbook with newWorkspace: true: it gets its own workspace and manager, and you do not manage it.

This batch carries jobs, handed off by other runs. A hand-off gives the task away: the run that handed a job off is not
told how it ends (a job marked "detached"; only a job of an older plugin version may still be waited for by its run). Each job has its own inputs (and the
outputs set at earlier stages); the steps read them all through {{ run.jobs }}. Use settle_job:
- without an outcome, to set a job's outputs (for example a release tag that later stages read);
- with an outcome (for example "ejected"), to end a job now: the run that handed it off is told at once
  (unless the job is detached), and this batch goes on with the others.
  The singleton's playbook decides what an outcome does to the job (see \`settle.effects\` of the step in get_run): it
  ends it (the default), \`continue\`s it (it stays in this batch), or \`requeue\`s it: the job leaves this batch and goes
  back to its stage's queue, with no failed ride (it may be requeued up to the stage's \`queue.max_requeues\`, then it
  fails). For a requeue give a reason (summary) and, if you know what it waits for, blocker (any text, a URL for example):
  the plugin only stores and shows them. A requeued job is no longer in {{ run.jobs }}.
A step with \`settle\` (see get_run) settles the jobs itself: when you complete it, the plugin applies its
settle output (YAML per job id: outputs, an outcome for a job that ends now or is requeued, with reason and, for a requeue, optionally blocker), and complete_step refuses
entries that do not apply. Do not call settle_job for those entries, and do not pass the settle output in
complete_step: the plugin takes it from the step's report (a value of yours replaces it, and never with fewer
entries). Never turn an outcome the agent did not give into one (no_deploy, ejected...): send the step back.
A step that reports an outcome with an \`ask\` (asking, needs_input) has its ask opened by the plugin at once: it
is answered through that ask (the human, or resume), never by a nudge_step.
A detached job that ends with an outcome (ejected, no_deploy...) is told to nobody: you are the only one who can start what
follows (for example its rework). Start it with start_playbook (newWorkspace: true, forJob: "<jobId>": the plugin records the
run), or call record_followup with a note when none is needed. Until every such job has a follow-up recorded, the plugin keeps
you alive and reminds you: do not end your turn first. get_run shows each job's followUps (do not start a second one). If
every job has left the batch, the steps not started are skipped.
When the batch completes, its jobs still open pass this stage and go on to the next ones. If the batch
fails, they wait here for the next batch (within the stage's retries), then fail.
${jobs ? `Jobs on this batch:\n${jobs}` : "This batch carries no job."}

Ready now: ${ready.join(", ") || "none"}. Start them with start_step.`;
}

/** Sent to the agent that created a run's manager when the manager was archived and the run failed. */
export function managerLostNotice(run: { id: string; playbook: Playbook; failure: string | null }, reached: string[], restartable: string[], cause: string): string {
  return `[playbooks] Run ${run.id} (${run.playbook.title}) failed: ${run.failure ?? "manager lost"}. Step${reached.length === 1 ? "" : "s"} reached: ${reached.join(", ") || "none running"}. ${cause}. Restart it with restart_run({ runId: "${run.id}", stepId: "${reached[0] ?? restartable[0] ?? ""}" }) (restartableFrom: ${restartable.join(", ") || "none"}); if its workspace is gone or busy, add workspaceId. Completed steps keep their outputs.`;
}
