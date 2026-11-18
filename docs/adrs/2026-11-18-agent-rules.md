# Agent rules

## Status

Accepted

## Context

Repositories have house rules that every agent of a run should follow (how to run shell commands, what to check before polling).
Today the only repo-wide text is `defaults/manager.md`, and it reaches the Playbook Manager alone. Step agents get their role's
instructions; putting a rule in every role and every playbook is repetitive and easy to miss.

## Decision

- A key `agent_rules:` holds a list of strings, in `defaults/main.yaml` (repo-wide) and in a playbook (added to it). It stays a flat
  list, not a block: it is one list with no options, as `tiers` is. A later option would go in a block under a new key.
- Validated at load, in the defaults and in the playbook: it must be a list, at most 20 entries, each a non-empty string of at
  most 500 characters (after trimming). Otherwise the playbook is invalid with a message naming the entry; `validate_playbooks`
  reports it like any other error.
- Merge: the repository's rules, then the playbook's, then those of its sub-playbooks; trimmed; each rule once. There is no
  opt-out or replace: manager instructions have none either (they only add).
- The loaded playbook carries `agentRules` (default `[]`, so older run files load). Prompts render it as a "Rules" section the
  plugin writes, apart from the playbook's own prompt, which cannot override it: in step agents' system prompts after the command
  rule, in role deciders' system prompts after the role instructions, and for the manager after its instructions (in the
  `start_playbook` result, the takeover and singleton kickoffs). After-task agents are step agents; fan-out child managers are
  managers of the child playbook, which has its own rules. The Sidekick is not a playbook agent and gets none.
- With no rules, every prompt is byte-identical to before.
- Rules are rendered when an agent starts or restarts. A running agent keeps its prompt. Run details and `get_run` do not show them.

## Consequences

- A repository sets a rule once for all its agents; the cost is a few lines in every prompt, hence the limits.
- Changing the list does not change running agents; restart them to apply it.
- A rule cannot be switched off for one playbook; if that is needed, a later ADR adds a block for it.
