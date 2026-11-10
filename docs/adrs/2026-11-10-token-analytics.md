# Token analytics: usage recorded per agent, an Analytics tab and a `get_analytics` tool

Status: Accepted

## Context

Nothing recorded what a run spent. The plugin read an agent's `lastUsage` only to decide on compaction. To make
playbooks cheaper (which step, role or model costs the most, which retries are wasted) the human, and the LLMs that
maintain playbooks, need the numbers.

## Decision

- On every `agent.turn_ended` the plugin reads the agent's `lastUsage` and adds it to a `usage` total
  (`UsageSchema`: turns, input, cached input and output tokens, cost, peak context): on the step attempt, on the
  gate (role decider), or on the run (`managerUsage`, while it is the manager's active run). All fields are optional:
  runs from before show no usage, and script and hand-off attempts have none.
- `shared/analytics.ts` (`analyze`) sums the runs on disk by playbook, step (with its role and model), role and
  model, with wasted attempts (not the step's last attempt, or one whose agent did not finish) and their tokens,
  plus the managers' and deciders' share.
- Three surfaces over that one function: the `analytics.state` RPC, the `get_analytics` agent tool (any agent
  except step agents; read-only; `days`, `playbook`, `projectId`, `limit`), and an **Analytics** tab on the
  Playbooks screen next to **Runs** (the former content).

## Consequences

- Assumption: `lastUsage` is the usage of the turn that just ended. If the provider reports cumulative values the
  sums overcount multi-turn agents; the peak context is right either way.
- Run files grow by a few numbers per attempt. No YAML change.
- Analytics read every run file in memory, archived ones included; no new storage.
