# `failure` is always an outcome of a script step

## Status

Accepted

## Context

A script step's non-zero exit is reported as the outcome `failure`. A step that declared
`outcomes: [a, b]` without `failure` therefore had a report the engine refused as "not allowed":
the default transition (`failure` retries, then fails the run) was never reached, `retries` were
never applied, and the manager was told to complete the step by hand. In a polling loop between a
reviewing agent step and a check script, each such failure woke the manager. Agent steps default
to `[success, failure]` and need not declare `failure` in a report; hand-off and fan-out steps
fix their outcomes and include it.

## Decision

- The loader adds `failure` to the outcomes of a script step that does not list it (appended, so
  the first outcome still completes by default). `on.failure` is accepted on such a step.
- A non-zero exit then takes the normal path: retried while `retries` allow, then `on.failure`,
  else the run fails; the manager is woken per the usual rules after the retries.
- No load warning: playbook loading has no warning channel, and none is needed now that the
  behaviour is the expected one.

## Consequences

- Playbooks that declared outcomes without `failure` now get their `retries` honoured.
- The step's outcome list (graph, `on` validation) includes `failure`.
