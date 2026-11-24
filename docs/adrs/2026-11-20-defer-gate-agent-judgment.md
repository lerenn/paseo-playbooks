# defer_gate on the agent's own judgment, for routine gates

## Status

Accepted. Extends `2026-11-20-deferred-gates.md`, which limited `defer_gate` to the human's stated wish.

## Context

Routine gates that only wait for something outside the human's hands (a PR merge, a CI run, another run) kept sitting
in Needs you until the human asked the Sidekick to set them aside. That is noise the Sidekick can sort out itself,
provided a deferral never decides anything and never passes for the human's consent.

## Decision

- `defer_gate` gets an optional `initiative`: `human` (default, the human asked, as before) or `agent` (the agent
  chose to). The tool description and the Sidekick prompt allow `agent` for routine gates that plainly cannot be
  decided yet, with the best tracked condition the run data supports (`date`, `run_ended`, `gate_decided`), else
  `manual` with a note and a `remindAt`, and a stated reason. The agent then tells the human what it set aside, why and
  what brings it back.
- A self-initiated deferral is recorded as `agent <name> on its own judgment` in `deferredBy` (and `gate.deferred`),
  never as "on behalf of the human": no consent is inferred or faked. No new persisted field.
- Human-only sensitive gates (secrets, credentials, IAM, auth or permissions, data loss, billing, production go/no-go)
  stay in Needs you unless the human explicitly asks to defer them (`initiative: human`). This is guidance in the tool
  and the prompt: the plugin has no reliable sensitivity flag to enforce it.
- Scope is unchanged: agents outside the runs only (so not a run's manager, step or advisor, which cannot set their own
  gates aside), a Sidekick only in its project, refused with `gates: { on_behalf: deny }`. Deferral still never decides.

## Consequences

- The Sidekick can keep Needs you to what needs a decision now, and the human is told afterwards.
- Because enforcement of "sensitive" is by instruction, the `deferredBy` record and the `gate.deferred` event are the
  audit trail; the human can bring any gate back with the panel or `return_gate`.

## Amendment (2026-11-24)

The Sidekick prompt now makes the self-initiated deferral mandatory, not optional: a routine gate that waits for something
external MUST be deferred (never left open with a promise to check later), in its own prompt section. The prompt also tells
the Sidekick that `defer_gate` and `return_gate` are deferred tools to load with `ToolSearch` before first use, and to
report a loading failure to the human. The sensitive-gate exclusions are unchanged.
