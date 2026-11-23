# The Quota limitation tab is one collapsible row per project

Status: Accepted. Refines `2026-11-23-quota-limitation-per-project.md` (its layout: a card per project, then a card per provider).

## Context

The tab listed the projects' limits, then every provider with its windows and the pace figures for each distinct `usable_percent`. Reading
what one project could expect meant matching a percent to a project name by hand.

## Decision

- The tab is a line with the steps running and active runs (global, the caps count those), the runs held by the caps, and one
  collapsible row per project. No separate provider section.
- A collapsed row: a state dot (green room, amber usage unavailable or no room, red over the pace, grey pacing off), the project's pacing,
  a short state per provider (`claude 12% free`, `codex over the pace`) and the step and run caps (or "No caps").
- An opened row: per provider and usage window a bar and plain numbers. Paced for the project: grey usage up to the pace ceiling, red for
  the excess, green for the free room (headroom minus reservations), a tick at the ceiling; "Used · Free · Ceiling" or "Over by". Pacing off
  or a model window: a plain grey bar and "Not paced". Reset and last-read times, and the project's reservations, holds and exhausted marks.
- The pace figure of a window is the one for the project's own `usable_percent` (the server still computes one per distinct percent);
  `QuotaRunRef` gains an optional `projectId` so reservations, holds and exhausted marks are listed under their project.
- Green, red and amber come from `client/semantic-colors.ts` (fixed hues), so colour is never theme-dependent; numbers always accompany them.
- The limits are read from the project's main checkout and resolved with `resolveForNewRun`, not from whichever workspace the panel listed.

## Consequences

- Read-only; no change to the playbook format, run state or agent tools. The RPC payload grows by one optional field.
- A project with several sets of limits (profiles with different defaults) shows each set's providers under the project, labelled by repositories.
