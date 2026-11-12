# `manager.mode`: a playbook can run with no Playbook Manager

## Status

Accepted

## Context

Every run has a Playbook Manager agent that starts each step, applies each report with `complete_step`, opens gates and tells the human. `2026-11-12-step-auto-completion.md` measured how little judgement that is for routine runs: in `release_trains` 38 of 38 outcomes the manager applied were exactly the reported ones, and across all runs 726 of 760 report-to-apply pairs left the outcome unchanged. A playbook whose steps need no coordinator can drop the agent, its tokens and its failure modes (a lost manager, a stale inbox). Pipelines already run with `managerAgentId: ""`.

## Decision

1. `manager: { mode: always_on | none }`, a field of the existing `manager:` block of a playbook. `always_on` is today's behaviour and the default. `on_demand` (a manager woken only for what needs judgement) is a possible future mode: it is **not** supported now, and the loader refuses it with "not supported yet".
2. The repository default goes in `defaults/main.yaml`. There `manager.mode` already means the manager agent's permission mode (`default`, ...), so the default is written `manager: { lifecycle: none }`; a playbook's own `mode` wins. (A deviation from "a default mirrors the block it defaults": the key is taken.) `none` on a singleton is a loader error when the playbook sets it, and is ignored when it only comes from the defaults (a train always has a manager).
3. Mode `none`: no manager agent is created. The run has `managerAgentId: ""` (as a pipeline), and `playbook.managerMode: "none"` (new field, default `always_on` for older runs; `isManagerless(run)`). The plugin does the manager's work in its tick (`driveManagerless`):
   - starts the ready agent steps (same model resolution and prompts as `start_step`, no brief); script, hand-off and fan-out steps are the plugin's already;
   - applies every reported agent outcome (the generalised `role.completion.auto`: `engine.completeStep` with the report, same validation and events), whatever its transition: complete, end, goto, ask (opens a human gate), retry or fail. The safety guard of `role.completion.auto` is not needed because the plugin owns gates, ends and hand-offs;
   - opens the gate of a ready gate step (`engine.requestGate`, summary = the step title). A role-decided gate then starts its decider through the existing `runDeciders`. A `by: manager` gate (also an ask or loop-limit gate) is a human gate: there is no manager to decide it;
   - human gates are shown in the panel (Review / Needs you) and decided there. The Sidekick gate sweep and `gate.escalated` / `gate.opened` events are unchanged.
4. Failures stop the run. An outcome whose transition is `fail`, a retry that is spent, a step that ends without a report, an undeclared outcome, a report that cannot be applied, a step that cannot start, a lost or stopped step agent: the run is failed (`failRun`) with the step's text in `failure`. It stays visible in the panel, `run.failed` is emitted, `restart_run` works. Nothing is retried unless the YAML says so (`retries`, `on`, `goto`); a lost or stopped agent always stops the run.
5. Stalls: no nudging. A step past its `timeout` fails the same way (`timed out after N min`). The silence reminder (`role.silence`) is not armed. Without a `timeout` there is no stall handling. The one reminder the plugin still sends is "you ended without reporting" (`remindToReport`), which is about the session's tools, not a nudge.
6. Isolation guard: the check at the end of a step becomes a failure report, as before (the run stops). The check at the end of the run (original checkout changed while the run worked in its worktree) runs after the run has ended, so a gate on it could not be decided: in mode none the run is marked `failed` ("Isolation violated: ...", worktree kept). A gate was the human's first choice; it is impossible on an ended run, so this is the conservative substitute.
7. Step and decider agents are created top-level in the run's workspace (no `parent`), so a human can open them. `always_on` still creates them as subagents of the manager. Lifecycle code finds them by label and attempt (`findAttemptByAgent`, `RUN_LABEL`, `STEP_LABEL`), never by parent, so archiving, turn-end hooks, session reload, usage attribution and events work unchanged.
8. Prompts: `stepSystemPrompt` has a variant for mode none ("started by the plugin", "report and stop, the plugin applies it"). `MANAGER_PROTOCOL` and `managerKickoff` are untouched.
9. Tools: `start_step`, `complete_step`, `nudge_step`, `request_gate`, `escalate_gate` on such a run are refused with "has no Playbook Manager (manager.mode: none)". `start_playbook` starts it without caller or manager and ignores `autoStart`. `restart_run` ignores `takeOver`, creates no manager and the plugin starts the step. `start_after_task` is run by the plugin. The panel hides the manager buttons and "Ask manager to retry". `get_run` and `list_runs` show `managerMode`.
10. A fan-out child uses its own playbook's mode. A pipeline and its trains are unchanged.

### Sites that assumed a manager

| Site | Behaviour with no manager |
| --- | --- |
| `startPlaybook` | `managerAgentId ""`; `admitQueued` ticks, the plugin starts the steps |
| `startFromPanel` (same workspace, new workspace, fan-out child) | the plugin creates the run itself (reservation as before); no manager agent; "start with an agent" is refused |
| `startWithAgent`, `handOff`, `pendingHandoffs` | refused / never used |
| `ownedRun` (every manager tool) | refused with a clear message |
| `enqueue`, `deliver`, inbox, `wakeStalledManager`, `clearInbox` | no-op; state is read by the plugin |
| `reconcile` | no manager check; steps resumed or lost as before; reported steps applied by the tick |
| `onStepTurnEnded` (reports, losses, timeouts, token failures) | recorded as before, then the tick applies the report or fails the run |
| `onLateReport` | guard checked, then the tick applies it |
| `autoCompleteReport` | not used (every outcome applied by the tick) |
| `settleScripts`, `admitQueued` (slot free), `onCheckEnded` | the "wake the manager" lines are dropped; the tick starts what is ready |
| `startStep`, `autoStartReady`, `moveStep` | plugin caller `""`; no `parent` |
| `stepCandidates` | no manager provider to inherit: the defaults apply |
| `requestGate`, `escalateByManager` | refused; the tick opens gates |
| `runDeciders`, `startDecider`, `reportGateDecision`, `escalate`, `onDeciderTurnEnded`, `reconcileDeciders` | unchanged; no `parent`; lines dropped; an escalated gate waits in the panel |
| `decideGate`, `dismissQuestions`, `gateManagers` | no manager to dismiss; the tick starts what follows |
| `cancelRun`, `pauseRun`, `resumeRun` | no manager to tell; resume ticks and applies what waited |
| `failRun`, `failManagerLost`, `onAgentArchived` (manager), `adoptOrphanedRun`, `managerLostNotice` | not reachable: no manager can be lost; an archived step agent is a lost step |
| `restartRun`, `createReplacementManager`, `takeOver` | no manager is created or taken over; the tick starts the step |
| `startAfterTask`, `askManagerToRetry` | the plugin runs the task; retry by restart (the panel hides the button) |
| `checkSilence`, `armWatch`, `remindToReport` | silence not armed; the report reminder stays |
| `onTimeout` | the failure report is applied by the tick |
| `cleanupEndedWorktrees` (isolation guard) | the ended run is marked failed |
| `recordUsage` | by attempt and gate; `managerUsage` stays empty (analytics: no manager overhead) |
| `oversight-events` actors | no manager actor |
| `onManagerTurnEnded`, `compactManager`, `busyManagers`, `retiredManagers` | never see the run |
| client: manager buttons, start result | hidden when `managerAgentId` is empty |

## Consequences

- A routine run costs no manager tokens and has no lost-manager failure; every outcome is final, so a playbook picks `none` only when it trusts its steps and its gates.
- Run state gains `playbook.managerMode` (default `always_on`); older runs load unchanged. `always_on` runs behave exactly as before.
- With no manager, a human or the Sidekick follows a run through the panel and events; the conversation surface for human gates (a question in the live step agent's chat, closed from either place) is a follow-up (`2026-11-12-gate-conversation.md`).
