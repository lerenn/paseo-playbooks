# read_agent_conversation tool, and the Sidekick's thoughts closed by default

## Status

Accepted

## Context

To see what another agent did, the Sidekick had only Paseo's `get_agent_activity`, which points at a large log file. With no shell it handed the reading to a subagent. In the column, the Sidekick's reasoning was shown in full between its answers.

## Decision

- A new plugin tool `read_agent_conversation` (given to every agent but step agents, pre-approved for the Sidekick) reads any agent's timeline through the daemon API and returns it as plain text, oldest first: messages, tool calls (name and status), errors. Reasoning and tool input are opt-in (`includeReasoning`, `includeToolDetail`). It pages backwards with the returned `before` cursor.
- The Sidekick prompt tells it to read agents itself with this tool.
- In the column, a reasoning block is one closed "Thought (show)" line that opens on click.

## Consequences

A new tool name in the agents' contract; additive. The Sidekick no longer needs a subagent to read a transcript.
