# Reload agent sessions left behind by a plugin reload

Status: Accepted

## Context

Claude agents get one HTTP MCP endpoint serving Paseo's and the plugins' tools. A plugin reload
changes the plugin's instance id, so the endpoint stops listing the old tools, but a running
Claude session keeps the tool list it connected with: its calls to the plugin's tools fail with
"Tool X not found". The daemon repairs this on the agent's next prompt, but skips an agent with
a run in flight, so an agent mid-turn at reload time stays broken until its turn ends. Retries,
`ToolSearch` and `/mcp` do not help. `agents.ref(id).reload()` (what `paseo agent reload` does,
from a non-agent caller) reopens the session, keeps the history, and re-runs the session-open
hooks, but it cancels a turn in progress.

## Decision

- A plugin-side step only; no Paseo core change. The plugin reloads such sessions itself with
  `agents.ref(id).reload()`.
- The daemon exposes no plugin generation per session, so the plugin records one: the
  `agent.session_open` hook (where it attaches its tools) notes the agent against the current
  *generation* (a random id per load of the plugin) in `<plugin data>/sessions.json`. The record
  is persisted because a reload starts with empty memory.
- An agent is stale when its record names an older generation. An agent with no record (its
  session predates this version) is treated as stale only when it is a manager, step or decider
  agent of a run; other agents with no record cannot be told apart from agents that never held
  the plugin's tools, so they are left to the daemon's repair on their next prompt.
- When: on start (after reconcile, over the non-archived agents) and at the top of every
  `agent.turn_ended` (before anything the plugin sends next). So an agent mid-turn is reloaded
  as soon as its turn ends.
- Safe: only when the agent is `idle`, with no active turn and no pending permission or question;
  at most one attempt per agent per generation (also when it fails); each reload and each failure
  is logged.
- Setting `reload_stale_sessions: true | false` (default true) in `defaults/main.yaml`, read from
  the agent's workspace. It is flat, not a block: it is a switch for a plugin behaviour, not the
  options of a playbook feature, and the user named it so.

## Consequences

- A daemon restart also starts a new generation, so idle agents of the old one get one reload
  too (their sessions were reopened anyway).
- The first update to this version reloads only run agents; coordinators that held tools before
  it have no record and recover on their next prompt, as before.
- Not verified without an installed update: a real plugin reload against a live daemon.
