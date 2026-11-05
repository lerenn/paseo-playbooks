# Sub-playbook outcomes: a block tells its parent how it ended

Status: Accepted

Refines `2026-11-03-end-inside-block.md`.

## Context

`end` inside a sub-playbook ends only its block, and the parent goes on. That is right when
the block is the whole story, but not when the parent's later steps only make sense if the
block went all the way. The anyshift release (ANY-2906) extracts dev, stg and prd into one
hidden `env_release` sub-playbook used three times: when dev finds nothing to deploy
(`no_deploy: end`), only the dev block ends, so stg, the `prd_go` gate and prd still run.
The design ADR left a step-level `when:` open, but that would need a condition on every
later step and a small expression language.

## Decision

- A playbook may declare top-level `outcomes` (default `[success]`). The first is a normal
  finish: all steps done, or a plain `end`.
- `{ end: <outcome> }` (an agent step's or a gate choice's transition) ends the playbook like
  `end` and names one of its `outcomes`. An outcome that is not declared fails validation.
- A playbook step takes the sub-playbook's outcomes and accepts `on`, as any step: every
  outcome but the first needs an entry, and it leads to `complete` (the parent goes on, as
  today), `end` / `{ end: <outcome> }` (ends the playbook the step is written in: the run at
  top level, else the block around it, which passes its own outcome up in turn) or `fail`.
  `goto` and `ask` are refused there, and so is `on` on an after-task playbook step.
- Ending a block with an outcome skips its unfinished steps as before; an `end` route then
  skips the enclosing block's unfinished steps too. The run records `block_outcome` and, at
  top level, `run_outcome` in its history.
- Run alone, a playbook ended with an outcome simply completes.

## Consequences

- Additive: playbooks without `outcomes`, `{ end: … }` or `on` on playbook steps behave as
  before. Run state gains optional `outcomes` and `on` on its blocks; older plugin versions
  ignore them, so a run they read treats every block end as `complete`.
- `when:` stays open for conditions on values; outcome routing covers early exits.
