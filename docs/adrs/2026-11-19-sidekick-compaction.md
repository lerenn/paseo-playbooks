# Sidekick compaction instead of recreation

Status: Accepted

Supersedes the "Session hygiene" rule of `2026-11-11-sidekick-runtime.md` (the Sidekick is asked to hand off and is
replaced by a new agent past `sidekick.session.restart_above_tokens`). The rest of that ADR stands.

## Context

Replacing the Sidekick when its context grew could leave two Sidekicks alive at once: the old one still
streaming while the new one started, a message landing on the old one, double cost, two tabs. Managers already
avoid this: the plugin sends them `/compact` when they are idle and past a threshold.

## Decision

- Past `sidekick.session.compact_above_tokens` (default 300000; `restart_above_tokens` is its older name and still
  works) and idle at the end of a completed turn, the plugin sends `/compact <what to keep, with the saved ledger>`
  to the same agent (the same daemon call as for managers: a message the provider runs as a command). Agent,
  label, session and tab are unchanged. `sidekick_handoff { restart: true }` asks for the same, now.
- The ledger (`sidekick_handoff`) stays in `sidekick.json`. It goes into the compaction instructions, and when the
  compaction ends the plugin sends a short note with the ledger again, with the notices held meanwhile.
- Safety net: if the send fails, the compaction turn fails, or the context is still above
  `sidekick.session.hard_limit_tokens` (default 1.5 × the threshold) afterwards, the old recreate path runs: the old
  agent is archived first (if that fails nothing new is created), then the new one starts from the ledger.
- At most one live Sidekick per project: creation, restart and replacement run one after the other per project;
  every launch archives any other live agent labelled `playbooks/sidekick` + the project; at startup duplicates are
  reduced to one (the record's agent if alive, else the newest) and the rest archived, with a log line.
- UI: `sidekick.list` returns `compacting`; the column shows "Compacting…" in the chat (no new tab, history kept)
  and queues the human's messages until it ends.
- Additive config: `session.compact_above_tokens`, `session.hard_limit_tokens`.

## Consequences

- No second Sidekick, and no new session from an ordinary context growth.
- After a plugin reload mid-compaction the in-memory "compacting" flag is lost: the compaction still ends, but the
  ledger note is not sent after it (the instructions carried the ledger).
- A provider without `/compact` gets the old recreate behaviour, now safe.
- Not tested live against a real compaction of a live Sidekick.
