# Script steps: live output in the step sheet

## Status

Accepted

## Context

The plugin ran a script step's checks and kept the tail of stdout/stderr in memory, but recorded it only when
the check ended (`attempt.lastMessage`). While a check ran, or between two polls, the human could not tell
whether the script was running or waiting, nor see what it printed.

## Decision

- The runtime keeps, per live script attempt, the running check's tail (stdout and stderr in arrival order,
  capped at the existing 4000 characters) and the last five ended checks (number, start/end, outcome, exit
  code, tail). It lives in memory only and is dropped when the attempt stops (step ended, run canceled or
  archived, timeout).
- A new RPC `runs.script-output` `{ runId, stepId }` returns `{ running, since, tail, checks[] }`. It is
  small and bounded, so the step sheet polls it every 2 s while the step runs, instead of widening the run
  state the panel already polls or persisting streamed output.
- The sheet states **Running now** (with elapsed time) or **Waiting** (with "next check in ~N s", from the
  persisted `nextCheckAt`), shows the live tail, and the ended checks. With nothing in memory (daemon
  restart, step ended) it falls back to the persisted last-check output, as before.

## Consequences

- After a daemon restart the live buffer is empty until the next check; nothing breaks.
- Script output may contain secrets. It is not redacted and is shown to anyone who can see the panel, exactly
  like the end-of-check tail shown before.
- Memory is bounded: one tail plus five check tails per live script attempt.
