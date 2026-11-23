# Dismissed review findings: an agent tool and a run-state record, keyed per PR by a finding signature

## Status

Accepted.

## Context

In babysit loops a code-review bot re-reviews the whole diff on every head and raises the same findings again, so the loop never
ends (35 rounds and 52 findings were seen). The bot cannot answer a thread question, so a reply on the PR does not stop it. The
loop's check and advisor are written in each project's own playbooks, not in this plugin; what the plugin can give them is a
place to say "this finding was looked at and dismissed, here is why", and a way to read it back.

## Decision

- **Tool `dismiss_finding { runId, pr, file, text, severity, category, rationale }`**, a non-step agent tool (the loop's manager; a step
  reports the finding to its manager). It records the dismissal on the run, emits `finding.dismissed` (who, why, signature: a
  `gate.decided`-style event, but not a gate: nobody is asked) and writes a `finding_dismissed` history entry. It posts nothing:
  **replying on the PR thread with the rationale stays with the caller**. Idempotent per PR and signature (`changed: false`).
- **Guardrails, in code, not in a prompt.** Severity and category are required. Refused, with the finding left to a human: P0 and P1
  (and critical, blocker, high, major), a severity that is not recognised, and any category with a whole word of security, auth*,
  secret(s), credential(s), IAM or migration*. The rationale is required (20 characters or more). A refusal records nothing.
- **Signature** (`server/findings.ts`, `findingSignature`): `fs1:` + the first 16 hex characters of SHA-256 of
  `<file>\n<text>`. The file loses `./`, a leading `/` and backslashes (case kept). The text is NFKC, lower case, with markdown
  links and images reduced to their label or dropped, URLs, severity badges (`P2`, "badge"), line references (`L42`, "line 42")
  and bare numbers dropped, every other run of characters one space, cut at 300 characters. It does not depend on the PR, the
  comment id or the head sha, so a re-raised finding has the same signature. `fs1` is the version: a change of the algorithm
  gets a new prefix and keeps the old records readable.
- **Where the record lives: on the run** (`Run.dismissedFindings`, default `[]`, so older run files load), because the rationale,
  the history entry and `get_run` (`dismissedFindings`) already belong to a run, and no new store has to be kept, archived and
  migrated. The per-PR view is a **read tool `list_dismissed_findings { pr, file?, text? }`** that merges every run's records for the
  PR (the oldest record of a signature wins). With `file` and `text` it computes the signature itself and answers `dismissed`,
  so a project's check script never has to reimplement the normalisation. The PR is kept as `owner/repo#N` (lower case) from a
  URL, `owner/repo#N` or `owner/repo/pull/N`.
- **No setting.** The guardrails are fixed in code, the tool does nothing until called, and a profile or playbook switch would
  only add a way to weaken them. A later ADR may add one if a project needs different categories.

## Consequences

- A project's check (the playbook's own script or agent) lists a PR's findings, calls `list_dismissed_findings { pr, file, text }`
  for each and skips those with `dismissed: true`; its advisor calls `dismiss_finding` for the ones it judges moot, then replies on
  the thread. The loop can then end on the findings that are left.
- The signature is exact on normalised text: a bot that rewords a finding gets a new signature and is dismissed again. That is the
  accepted cost of not guessing at similarity.
- Dismissals live and die with their run (archiving keeps them; deleting the run loses them). A PR looped over several runs is
  covered by the merged read.
- Any non-step agent can dismiss on any run, and `by` and the event show who. It is visible, not prevented.
- Run state gains `dismissedFindings`; there are two agent tools, one bus event (`finding.dismissed`) and one history type.
