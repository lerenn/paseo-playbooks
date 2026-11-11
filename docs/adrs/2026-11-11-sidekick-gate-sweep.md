# Sidekick: an end-of-turn sweep of open gates

## Status

Accepted

## Context

A Sidekick learns of gates only through the events it watches (`gate.escalated`) while it is awake. A gate that opened while it was busy, or whose event it missed, stayed unanswered until the human noticed.

## Decision

- When a Sidekick's own turn ends, the plugin lists the open gates of its project's non-archived runs that wait for a human (`waitsForHuman`). If some were not yet put to this Sidekick, it sends one message naming them (run, step, gate) and asking it to treat them: decide those its rules allow, put the rest to the human.
- Each gate is listed once per Sidekick session (`runId:gateId`, kept in memory, cleared when the gate closes or the Sidekick is replaced), so a gate left for the human does not make the Sidekick loop turn after turn.
- The message joins the existing end-of-turn messages (held subagent notices, hand-off request).

## Consequences

An answered-late or missed gate reaches the Sidekick at its next turn end. A restarted daemon forgets the list and lists open gates again once. The agent tools' contract is unchanged.
