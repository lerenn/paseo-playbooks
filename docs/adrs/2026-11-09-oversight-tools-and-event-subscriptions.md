# Oversight tools: list_gates, read-only get_run, event subscriptions

Status: Accepted

## Context

Nothing lists the gates and asks that wait across runs, and `get_run` (like `resume`,
`complete_step`, `start_step`, `nudge_step`, `request_gate` and `settle_job`) is limited to the
run's own manager (`run X belongs to another manager`). An agent that watches the daemon for a
human, or one that should react as soon as a question or a gate appears, has to poll `list_runs`
and cannot see what a gate asks, who may decide it, or why a run failed. Louis wants such an
agent later, in real time. The plugin should not know that agent as a special kind: it offers
generic tools any agent can use.

## Decision

- `list_gates { runId?, olderThanMinutes?, includeFailed?, includeFinished? }` (every agent
  except step agents): every open gate step, `ask` and loop-limit gate of the active,
  unarchived runs, oldest first, with run id, playbook, run name, workspace, manager, step id,
  kind, question (the gate's summary), choices, decider (`human` / `manager` / `role` and its
  role), who holds it now (`heldBy`: "human", "manager (or a human, if it asks)", or
  "role X" while the role still decides, with `roleDeciding` and `waitingForHuman`), opened-at
  and age in minutes. `includeFailed` adds the failed runs (a lost manager included) with
  `failure`, `managerLost` and `restartableFrom`. The output is compact and stable (same fields,
  fixed order), so a scheduled agent can call it and compare.
- `get_run` becomes a tool of every agent except step agents and is read-only on any run, in
  both views. Every write keeps `ownedRun` and its "belongs to another manager" error. The
  full view is allowed and not redacted: the run file holds no secrets the plugin knows of
  (inputs and reports are text the user and agents wrote), and any agent on the daemon can
  already read those conversations with Paseo's own tools. Only the run's own manager clears
  its wake-up inbox by reading it. `cancel_run`, `restart_run` and `start_after_task` stay as
  decided in `2026-11-03-cancel-from-any-agent.md`: any agent may call them, so a human can
  stop or restart a run from any chat. They are not changed here.
- A small internal event bus (`server/bus.ts`) that knows nothing of gates or runs:
  - an event is `{ id, seq, type, at, runId, source, payload }`; `seq` is monotonic and survives
    restarts; types are dotted names (`gate.opened`, `gate.stale`, `gate.decided`,
    `run.failed`, `run.manager_lost`, ...);
  - a producer registers a type (name, a zod payload schema, a one-line text for messages) and
    calls the single entry point `emit(type, payload, { runId, source, actors })`; the bus
    validates the payload. A new producer adds a type without touching the bus
    (`bus.test.ts` registers an extra type and sink to prove it);
  - `actors` are the agents that caused an event; the bus never delivers it to them, which is
    the loop rule (a manager or role decider is not told of its own decision);
  - a type may be a threshold type (`threshold: { default }`): subscribers choose the delay with
    the filter `olderThanMinutes`, and the producer asks `thresholds(type)` which delays to
    emit; the payload's `thresholdMinutes` says which one was reached.
- Subscriptions match on type with simple globs (`*` matches any run of characters:
  `gate.*`, `run.failed`, `*`) and on a generic payload filter: each key must be a field of
  the chosen types' payloads and is compared by equality (plus `olderThanMinutes`). A wrong
  type or key is refused with the known ones. Tools: `subscribe_events { types, filter? }`
  returns a subscription id; `unsubscribe_events { id }`; `list_subscriptions {}`. At most 20
  per agent; only the owner removes one.
- Delivery is a `Notifier` (`deliver(subscription, events, text) -> "delivered" | "gone"`),
  chosen by the subscription's `sink: { kind, target }`. Today there is one kind, `agent`: a
  plain-text message to the calling agent, sent with `steer` like manager wake-ups (refined by `2026-11-10-event-delivery-when-idle.md`: held until the subscriber is idle by default), naming the
  run and the tools to call. A webhook or Slack sink adds a notifier, not a producer or a
  subscription change. `gone` (the agent is archived or missing) drops its subscriptions, as
  does the `agent.archived` hook.
- Debounce is a property of delivery: each subscription queues its events and sends them as
  one message once the oldest has waited 5 seconds. Producers emit one event per occurrence.
- A bounded log of the last 500 events (a ring buffer, persisted in `events.json`) and
  `list_events { since?, types?, limit? }` (every agent except step agents) let an agent that
  was down (a limit, a restart) catch up: events after a `seq` in order, `lastSeq`, and
  `oldestSeq` to tell whether some were dropped. Subscriptions persist in
  `subscriptions.json`; both files sit in `$PASEO_HOME/plugin-data/paseo-playbooks/`, outside
  the runs folder.
- The first producer is `server/oversight-events.ts`: it watches the runs every 2 seconds and
  emits:
  - `gate.opened`: a gate step, ask or loop-limit gate opened (question, choices, decider and
    who holds it, so a role-held gate reads "held by role X", not "waiting for a human");
  - `gate.stale`: still open after `olderThanMinutes` (default 30); once per gate and delay,
    remembered through the log across restarts;
  - `gate.decided`: who decided, via panel, chat, manager or role, and the comment;
  - `run.failed`: a run failed, with the reason and `restartableFrom`; a run that lost its
    manager is `run.manager_lost` only. Failures of trains are left to the runs whose jobs
    they carry.
  Gates open when the daemon starts are not emitted as opened again. An event that happens
  while the daemon is down is not seen. Watching the runs is one producer's way; the engine
  or runtime can call `emit` directly for later types.
- Payloads hold run ids, names, playbook ids, workspace paths, step ids, gate questions,
  choices, deciders, failure reasons and gate comments; never run inputs, step outputs or
  reports.

## Consequences

- An agent started with a Paseo heartbeat or schedule can call `list_gates` periodically;
  one that wants real time subscribes. Neither needs the plugin to know which agent it is.
- Out of scope, as a later round: an agent that resumes gates for others (for example
  `decider: { by: agent }` on a gate, with its own reason and record). Subscribers only
  read and tell humans.
- Out of scope: waking an agent by other means than these messages, and pushing to Slack or
  e-mail. A wake-up by a heartbeat or schedule that calls `list_gates` stays the answer where
  polling every few minutes is enough.
- Scanning is polling inside the plugin. If two seconds proves too slow or too costly, the
  engine can emit events directly without changing the tools or the subscription model.
- A webhook, Slack or e-mail sink, and events of other kinds (deploys, schedules), are later
  additions: a notifier or a registered type each.
