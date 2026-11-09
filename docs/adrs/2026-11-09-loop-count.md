# Loop count: `{{ loop }}` in prompts and `when: { loop }`

Status: Accepted

## Context

`{{ attempt }}` counts retries of a step, not the times a `goto` sent the run back through it,
and `when` only tests the run's inputs. A reviewer loop could not say "round 2" in a prompt
(to ask for a stricter pass) or run an extra step only from the second round on.

## Decision

- Each step of the run keeps a loop count: the number of times a `goto` reset it (the target
  and every step downstream of it; an `ask` choice and an approved loop-limit gate go
  through the same reset). It is 0 on the first pass. Restarting a run from a step does not
  count.
- A step prompt may use `{{ loop }}`, its own count.
- `when` accepts the key `loop`, testing the step's own count: a number (equals), a
  comparison string `">=2"`, `"<3"`, `"==1"`, `">0"`, or a list (any holds):
  `when: { loop: ">=2" }`. A step whose test fails is skipped as for any `when`; the test is
  evaluated each time the step becomes ready, so it follows later loops.
- `loop` is not reserved: a playbook that declares an input named `loop` keeps `when: { loop }`
  testing that input. `when.loop` on a playbook step is an error (a block has no count; put it
  on a step of the sub-playbook).
- Not done: `{{ steps.<id>.loop }}` in input mappings; other steps' counts stay out of the
  template context.
- Run state: a step gains `loop` (default 0); older run files still load.

## Consequences

- Additive: playbooks without `loop` behave as before.
- The `when` grammar gains comparisons for this key only; inputs stay equality.
