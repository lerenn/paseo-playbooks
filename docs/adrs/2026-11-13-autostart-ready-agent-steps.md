# Ready agent steps start by themselves, and the manager is woken only to decide

## Status

Accepted. Supersedes decision 2 of `2026-11-12-start-playbook-autostart.md` for steps after the first
(there, only `start_playbook` started steps), and changes the manager contract of
`2026-11-12-step-auto-completion.md` (the quiet inbox line is gone).

## Context

Only `start_playbook`'s `autoStart` started agent steps; every later ready step needed the manager's
`start_step`, and the manager was woken after every step. In run_a0639b, `babysit.babysit_ci` sat `ready`
after a script step ended and nobody started it. Waking a manager on every completion also costs it a
turn per step for no decision.

## Decision

1. **Auto-start.** Every agent step starts by itself as soon as it becomes ready (after a predecessor, a
   script, a gate, a loop-back, a fan-in; also after-task steps), with the rendered prompt and inputs and
   an empty brief, through `startStep` (same model, role, workspace). A tick phase (`startReadyAgents`)
   does it for every active, unpaused run with a manager, so it is also the recovery sweep for a step left
   `ready`. `startStep` refuses a second start and guards a start in flight (`run/step`), so the plugin and
   a manager's `start_step` never create two agents. A step the plugin cannot start stays `ready`, is not
   retried in a loop, and the manager is told once.
2. **Opt-out.** A step-level block `manage: { auto_start: false }` (also `manage:` in `defaults/main.yaml`)
   keeps the step `ready` for the manager to start with a brief. Agent steps only; refused elsewhere.
   `start_playbook` with `autoStart: false` keeps the steps ready at that moment (run field `held`,
   dropped once started); later steps still start by themselves. A run with `manager.mode: none` starts
   all agent steps (nobody could brief them).
3. **Quiet manager.** The manager is woken only for something to decide or that went wrong: a reported step,
   a failure or exhausted retries, gates and escalations, a ready step only it can move (opted out, could not
   start, a gate to open), stalls (silence or timeout, lost agent, restart, provider out of tokens with a wait),
   batch and hand-off follow-ups, cancellation, and the end of the run. A step that completes normally whose
   next step starts by itself is recorded in the run log only. `manage: { notify: true }` opts a step in.
   A watchdog (`noticeReadySteps`, on every tick and at the end of the manager's turn) tells an idle manager,
   once, of a ready step waiting for it, so a quiet manager is never a silent stall.
4. **Block name.** `manage` is a new step-level block (a feature with its own block, per the format rules),
   not `role:` (it must also cover script steps for `notify`) and not `oversight` (already the name of the
   agent-oversight events). Defaults mirror it.

## Notices changed

Now quiet (run log only, no inbox line, no wake): script / hand-off / fan-out step ended normally and the
run goes on by itself; a step applied by `role.completion.auto` (was a queued line; still wakes with
`notify`, or when a gate, manual step or the end follows); a gate decided by a role while the run goes on by
itself; a slot freed for a step that starts by itself; an after-task started by a human whose steps start by
themselves; a step restarted on a fallback provider after tokens ran out (and after a wait). Unchanged
(wake): reported step, failure, gates and escalations, provider-wait start, silence reminder, timeouts, lost
agent, restart recovery (now lists only steps the manager must start), cancel, resume, restart_run,
isolation guard, batch and hand-off notices, human retry. Wake texts list ready steps as `x (starts by itself)`.

## Consequences

- A manager prompt from an older plugin that calls `start_step` right after a script gets a refusal, harmless.
- Existing playbooks change behaviour: steps no longer wait for a brief. Add `manage: { auto_start: false }`
  where a brief mattered, and `manage: { notify: true }` where the manager wants to be told.
- Tests that drive steps by hand construct the runtime with `autoStartAgents: false` (test-only option).
