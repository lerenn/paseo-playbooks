# Declared outputs are optional on a failure

## Status

Accepted

## Context

A step must report every declared output, except on `failure`. Since v0.111.3 a script step
allows `failure` implicitly, but a failure that took a transition applying the outputs check
(completing a step whose `on.failure` goes to a step or ends the run, or an ask choice with
outcome `failure`) was refused with `missing output "..."`. The run failed after one attempt
and the real error was hidden.

## Decision

When the outcome is the implicit `failure`, declared outputs are optional on every path
(report, automatic script report, `complete_step`, ask choices). Outputs given are kept when
well typed; missing or mistyped ones are dropped, not refused. Unknown names still error on a
refused report path that validates. A template reading a missing output of a failed step is
not special-cased: it errors clearly when evaluated, as for any unset output.

## Consequences

A failure always reaches its transition with its summary. Authors who need an output after a
failure must make the reader tolerate its absence.
