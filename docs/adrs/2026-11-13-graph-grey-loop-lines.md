# Graph loops: grey dotted lines by default, white on hover or tap

## Status

Accepted. Supersedes the "no back-edge line by default" part of `2026-11-13-graph-loop-badges.md`.

## Context

With no loop line drawn until a badge was tapped, users could no longer see that a playbook loops.

## Decision

- Every loop is drawn again as one thin, dotted, grey line per source and target (muted foreground
  at reduced opacity), behind the nodes, with an arrowhead at the target and no label. Lines whose
  layer spans do not overlap share a lane (`assignLanes`, restored in `client/loops.ts`).
- Hovering a step (web, desktop) whitens its lines, leaving and entering, makes them solid and
  slightly thicker, draws them on top and shows their outcomes with `n/max`. Others stay grey.
- Touch has no hover: a Repeat button on each step that is part of a loop, or its loop badge,
  pins the same highlight; tapping again clears it. Nothing is hover-only. A node's own tap still
  opens its conversation or details.
- Loop badges, the "Loops from X" list and the collapsed attempt chips are unchanged.

## Consequences

- The graph is wider again by one narrow gutter per lane, but the loops are visible at a glance.
- Highlight state is local UI state; run state and plugin APIs are unchanged.
