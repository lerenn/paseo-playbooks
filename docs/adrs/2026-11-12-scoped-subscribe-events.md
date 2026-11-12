# `subscribe_events` must be scoped

## Status

Accepted

## Context

Agents subscribed to `gate.*` or `step.completed` with an empty filter and were woken for every run on the daemon, flooding their turns.

## Decision

A new `subscribe_events` call is rejected when its filter has none of `runId`, `projectId`, `workspaceDir`, `playbook`, unless every requested type is exactly `gate.escalated`, `run.failed` or `run.manager_lost`. The error tells the caller to pass `{ runId }` (or `{ workspaceDir }` for runs it drives) and to avoid `step.completed` unless needed; the tool description says the same. Only the tool checks; stored subscriptions, the plugin's own project subscriptions and internal callers are unaffected.

## Consequences

Agents must name what they watch. Unscoped watching of rare, always-relevant events still works.
