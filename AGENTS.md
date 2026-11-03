# Agent instructions

## Architecture Decision Records (ADRs)

Every significant decision gets its own ADR in `docs/adrs/`, added in the same pull request
as the change it describes.

A decision is significant when it changes any of:

- the architecture, or how the plugin talks to Paseo (APIs, hooks, polling or events, RPCs)
- the playbook YAML format, run state, or the agent tools' contract
- a UI surface (a new panel, button or screen), not a restyle of an existing one
- compatibility, dependencies, packaging, or the release and versioning process
- the repository's development workflow (CI rules, worktree setup)
- a rule that an earlier decision set (say which one it supersedes)

Bug fixes, refactors, copy edits and visual tweaks need no ADR.

### Format

- File: `docs/adrs/YYYY-MM-DD-<short-slug>.md`, dated the day the decision is taken.
- Sections: **Status** (`Accepted`, or `Superseded by <file>`), **Context**, **Decision**,
  **Consequences**.
- Keep it short: one decision per file.
- Do not rewrite an accepted ADR to change a decision. Write a new ADR that supersedes it,
  and set the old one's Status to `Superseded by <new file>`. Fixing a mistake or a stale
  statement is fine.
- `docs/adrs/2026-11-02-design.md` is the original design and holds decisions 1–52. New
  decisions go in their own files, not in its list.
