# Graph back-edges: one line per source and target, tap to see the outcomes

## Status

Superseded by 2026-11-13-graph-loop-badges.md (for the default view: no back-edge lines are drawn until a badge is selected)

## Context

A playbook with many loop outcomes (a PR babysitter has about ten) drew one dashed lane per
outcome. The lanes made the graph wide and their rotated labels collided.

## Decision

- All loop outcomes from one step to the same target are one dashed line labelled with the
  outcome (when alone) or "N loops". Lines whose layer spans do not overlap share a lane
  (`client/loops.ts`).
- Tapping a line label, or a node's info button, selects that step: its lines turn solid in the
  accent colour and are drawn on top, the others fade, and a list under the graph shows every
  outcome with its `n/max` counter. Nothing is hover-only.

## Consequences

- The graph is narrower. Outcome names and counters are one tap away rather than always drawn.
- The selection is local to the graph; it does not change run state or the plugin's APIs.
