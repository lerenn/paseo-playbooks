---
name: extend-playbook-format
description: Add or change an element of the playbook YAML format (a playbook, step, after-task, transition, role or defaults field) in this repository. Use when designing a new option or step kind, moving a field, or reviewing a format change; it says where the element goes and that it goes in a block, not as a flat field.
---

# Extending the playbook format

The playbook YAML format is the plugin's contract with its users. Shape every new element the
same way, so the format stays one style. Decisions: `docs/adrs/2026-11-06-group-step-kind-fields.md`
(block form), `docs/adrs/2026-11-03-format-stability-until-v1.md` (breaking changes).

## Rule: block first

Options of a feature go in one block, under a key named for the feature. They are never flat
siblings of that key or of the feature's parent.

```yaml
# yes
singleton: { isolation_level: …, branch: main, parallel: false }
script: { run: wait_ci.sh, poll: 30s }

# no
singleton: true
singleton_branch: main
script: wait_ci.sh
poll: 30s
```

- A step kind is a block under its keyword (`role`, `gate`, `script`, `playbook`). An option
  that only one kind uses goes in that kind's block.
- A new feature gets its own block even if it has a single option today. Its next option then
  goes in the block without moving anything.
- A field stays flat only when it describes the parent itself rather than configuring a feature:
  `id`, `title`, `hidden`, `needs`, `retries`. A field that several step kinds share (`inputs`,
  `outputs`, `outcomes`, `timeout`, `on`) stays on the step.
- Do not add a `type:` or `kind:` discriminator: the block's key is the kind.
- Write examples in flow style (`{ a: 1, b: 2 }`) when they fit on one line. Use block style
  when a value spans several lines (a `prompt: |`).

Before adding a flat field, check whether it belongs to a feature that already has a block, or
to one that should get a block. If you still think it should be flat, say why in the ADR.

## Where it goes

| Scope                                 | Schema in `server/loader.ts`               |
| ------------------------------------- | ------------------------------------------ |
| The whole playbook                    | `RawPlaybookSchema`                        |
| Every step and after-task             | `RawStepSchema` (after-tasks extend it)    |
| One step kind                         | that kind's block in `RawStepSchema`       |
| A transition in `on`                  | `RawTransitionSchema`                      |
| A role                                | `RawRoleSchema`                            |
| A repo-wide default                   | `RawDefaultsSchema`, same block shape as where it is overridden |

A default mirrors the block it defaults. If `role: { silence }` exists on a step, the defaults
file has `role: { silence }`, not a flat `silence`.

## Checklist

1. **ADR first** (`AGENTS.md`): any format change is significant. If the change departs from
   block first, the ADR says why.
2. **Schema**: declare the block as a `z.object({...}).strict()`, so a mistyped key fails
   instead of being dropped. Give each field a `/** … */` comment, as the existing fields have.
3. **Misplaced use**: refuse the block on a kind or scope it does not apply to. The error names
   where it applies (`` `poll` only applies to a script step ``).
4. **Moved or removed forms**: until v1.0 there is no support for old forms. The old form fails
   with what to write instead (`` `poll` moved under `script:`: write `script: { run: x, poll: 30s }` ``).
   Label the PR `breaking-change` and put the migration under a "Breaking changes" heading.
5. **Loaded types**: map the raw block to `shared/types.ts`. Keep run state and the agent tools'
   contract unchanged unless the ADR says otherwise. A new run-state field gets a default so
   older run files still load.
6. **Tests**: add loader cases in `server/loader.test.ts` (accepted, refused, misplaced, old
   form).
7. **Docs and examples**: update `skills/paseo-playbooks/SKILL.md` (its playbook example is
   validated by `server/skill.test.ts`), `README.md`, `website/reference.html` (each entry ends with an example), `examples/.paseo/plugins/playbooks/`
   and this repository's own
   `.paseo/plugins/playbooks/`.
8. **Validate**: `npm test`, then call `validate_playbooks` on the examples and on
   `.paseo/plugins/playbooks/`.
