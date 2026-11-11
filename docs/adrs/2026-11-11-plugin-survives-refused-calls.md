# The plugin keeps serving after a refused or failed call

## Status

Accepted

## Context

A script step whose result the engine refused (an outcome the step does not declare) fell back to
recording a `failure` report. A step need not declare `failure`, so the fallback threw too. The throw
came from a timer callback, outside any tool call, and the plugin process exited. Every run lost its
tools until a manual restart.

## Decision

- Automatic results (script and hand-off) are recorded with `recordAutomaticReport`: a refused result
  becomes a `failure` report written directly, never an exception.
- Errors raised while handling an agent's tool call stay at the tool boundary: they come back to the
  agent as a tool error naming what is wrong and the allowed values.
- The server entry installs `unhandledRejection` and `uncaughtException` handlers that log and keep serving.

## Consequences

- One bad call or timer cannot take the plugin down.
- A step that does not declare `failure` and receives a failure result stays reported; the manager is
  told and completes it with an allowed outcome.
- Errors that were fatal are only visible in the logs.
