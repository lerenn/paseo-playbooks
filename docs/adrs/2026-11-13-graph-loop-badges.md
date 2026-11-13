# Graph loops: badges on the source step, one back-edge on demand

## Status

Accepted. Supersedes the always-drawn back-edge lines of `2026-11-13-graph-backlinks.md`. The "no line by default" part is superseded by `2026-11-13-graph-grey-loop-lines.md`.

## Context

Even merged per source and target, a babysitter's loops left about six dashed vertical lanes with
rotated labels that could not be tied to a source step. Steps retried dozens of times also showed
one chip per attempt, which pushed nodes far apart.

## Decision

- No dashed back-edge is drawn by default. A step that loops back shows one badge per distinct
  target: "↩ Target · N outcomes · M taken" (a lone outcome shows its name and `n/max`).
- Tapping a badge outlines the target node in the accent colour, draws only that back-edge (solid,
  accent) and lists its outcomes with `n/max` counters under the graph. Tapping again hides them.
- More than 6 attempts collapse to the last 4 chips plus a summary chip ("44 attempts · +40
  earlier"); tapping it expands every attempt, and "Collapse" folds them again. The latest attempt
  is always visible and nothing auto-collapses.
- (Lane assignment was removed here and restored by the grey-loop-lines ADR.)

## Consequences

- The graph is narrow and calm; every outcome and counter is still one tap away.
- The target is highlighted but the page is not scrolled to it.
- Selection and expansion are local UI state; run state and plugin APIs are unchanged.
