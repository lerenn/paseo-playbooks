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
- Subscriptions: `subscribe_events { events, filter? }` returns a subscription id;
  `unsubscribe_events { id }`; `list_subscriptions {}`. The subscriber is the calling agent and
  the plugin sends it a plain-text message (like the train gate notices,
  `2026-11-06-train-gate-notices.md`) naming the run and the exact tools to call (`list_gates`,
  `get_run`). Events:
  - `gate_opened`: a gate step, ask or loop-limit gate opened (question, choices, decider and
    who holds it, so a role-held gate reads "held by role X", not "waiting for a human");
  - `gate_stale`: still open after `filter.olderThanMinutes` (default 30); one reminder per
    gate and subscription, kept across restarts;
  - `gate_decided`: who decided, via panel, chat, manager or role, and the comment;
  - `run_failed`: a run failed, with its reason and `restartableFrom`; a run that lost its
    manager is reported as `manager_lost` only, never also as `run_failed`. Failures of trains
    are left to the runs whose jobs they carry;
  - `manager_lost`: as above.
  `filter` is `{ playbook?, runId?, deciderBy?, olderThanMinutes? }`; `deciderBy` applies to
  gate events. At most 20 subscriptions per agent.
- A subscriber is not told of a decision it took itself, which would echo its own call back:
  `gate_decided` is skipped for the run's manager when the gate was decided by it (`manager` or
  `chat`), and for the role decider agent of a role gate. Every other subscriber hears it.
  Subscribers only read, so no other loop exists.
- Delivery: the plugin scans the runs every 2 seconds and queues a line per event and
  subscriber; a subscriber's lines of a 5-second window go out as one message, sent with
  `steer` like manager wake-ups. Gates open when the daemon starts are not reported as opened
  again (only their decision, and their stale reminder if due). An event happening while the
  daemon is down is missed.
- Persistence: subscriptions live in `$PASEO_HOME/plugin-data/paseo-playbooks/subscriptions.json`
  (written atomically, outside the runs folder). A subscription is dropped when its agent is
  archived (the `agent.archived` hook), or when a send finds the agent gone or archived.
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
- Scanning is polling inside the plugin. If two seconds proves too slow or too costly, an
  event hook in the engine can replace it without changing the tools.
