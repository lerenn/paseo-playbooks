# The refreshed scripts copy is a git checkout

## Status

Accepted

## Context

`refresh_scripts` copies a run's script directories to `<data>/run-scripts/<run_id>`, and script steps then run
from there. Shell libraries find their checkout root with `git rev-parse --show-toplevel` run in their own
directory and keep scratch files in `<root>/.tmp`. The copy was a plain directory, so the lookup failed, the
script returned "not yet" at once and polled until its timeout. Runs that were never refreshed run from the
worktree checkout and were not affected. A timeout also reported only the number of checks.

## Decision

The copy is made a git repository (`git init`) before it is put in place, so it is its own toplevel and a
`.tmp` can be created in it. The cwd of the script is unchanged (the run's workspace). A script timeout
summary now ends with the last line the script printed.

## Consequences

Scripts see the same kind of layout before and after a refresh. The copy has no commits and no remote; scripts
that need the real repository use their cwd.
