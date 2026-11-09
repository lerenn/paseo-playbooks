# Compact the manager's context in place

Status: Accepted

## Context

A manager lives as long as its run, and every wake-up adds to its context, so long runs make
each turn costlier. Replacing it with a fresh agent seeded from run state would change the
conversation the human follows, so it is not an option.

Paseo's Claude provider runs `/compact` as a command when it arrives as a plain message. Sent
through the MCP `send_agent_prompt` it arrives wrapped in an agent-sender envelope and the
agent reads it as text; sent as a non-agent client (the plugin's `agents.ref(id).send`, or
`paseo send`) it compacts (verified on a throwaway agent: `[User] /compact`, `[Compacted]`).
After a refresh an agent's `lastUsage.contextWindowUsedTokens` holds its context size; it reads
0 right after a compaction.

## Decision

- Playbooks and `defaults/main.yaml` accept `manager: { compact: <policy> }`, in the existing
  `manager:` block. A playbook's value wins over the defaults'. Policies: `never`, `on_step`
  (after the manager handled a wake-up), `on_gate_decided` (after a gate decision),
  `{ above_tokens: N }` (after either, when the context holds more than N tokens). Default
  `{ above_tokens: 150000 }`.
- The plugin sends `/compact` only when the manager's turn has ended, its run's inbox is empty
  and no turn is running; a wake-up arriving meanwhile waits, as for any busy manager. A zero
  or missing token reading is ignored. A failed send is logged and not retried.
- The run's stored playbook gains `managerCompact` (defaulted, so older runs load).

## Consequences

- Run state lives in the plugin, so a compacted manager can re-read `get_run`; the manager keeps
  its conversation.
- A compaction costs one summarising turn: `on_step` on a short run can cost more than it saves,
  hence the token threshold as the default.
- Manual check that it compacts a real manager: run a playbook with `manager: { compact: on_step }`
  and look for `[Compacted]` in the manager's timeline after its first wake-up.
