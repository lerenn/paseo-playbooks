# The run form stays on the panel after Start

## Status

Accepted

## Context

`2026-11-12-run-playbook-form.md` and `2026-11-12-run-playbook-overview.md` say the new workspace opens after Start. That
pulled people away from the Playbooks panel they were working in. The form also showed the playbook description as a wall of text.

## Decision

After Start, the form closes and the UI stays on the panel it was started from (overview or workspace tab). A toast says
"Started <playbook> in <workspace>" and the runs list refreshes. Nothing is opened (the toast API has no action). The
playbook description sits in a closed "Description" disclosure row in the form.

## Consequences

Supersedes only the "opens the new workspace after Start" rule of the two ADRs above. The new workspace is opened from the run's row.
