# Overview summaries: `overview.state` returns compact run summaries

Status: Accepted

## Context

The Playbooks screen sat on "Loading..." for a long time. `overview.state` returned every non-archived run as a
full `Run`, and the screen fetched them on mount, on agent events (1 s batch) and every 60 s. On a real runs
directory (185 files, 44 MB; 65 non-archived runs) that response was 21.5 MB of JSON (step attempts and
outputs 13 MB, playbook prompts 4.5 MB, history 2.4 MB). The screen draws rows from a small part of it.

## Decision

- `overview.state` returns `RunSummary` objects (`RunSummarySchema`, built by `summarizeRun` in `shared/types.ts`):
  ids, workspace and project, name, a one-line `title` (the first text input, cut to 200 characters), status,
  timestamps, `seenAt`, `pausedAt`, each step's status only, the pending gates, after-task statuses, jobs
  without inputs and outputs, `train`, and a playbook summary (identity, stations, block titles, and per step the
  title, kind, `needs`, `outcomes`, `on`, `choices`, `when`, `afterTask`).
- Left out: history, inbox, inputs, outputs, attempts and reports, step prompts and wiring, decided gates.
- The client helpers (`isActive`, `isPaused`, `isPipeline`, gate choices, stations) take structural types, so
  both a `Run` and a `RunSummary` fit. The overview opens no node sheet, so no new RPC is added: whole runs
  stay on `runs.list` (the per-workspace panel, unchanged).

## Consequences

- The same data weighs 0.73 MB (largest run 27 KB) instead of 21.5 MB, and parses in 17 ms instead of 132 ms.
- A field the overview needs later must be added to `RunSummarySchema` and `summarizeRun`; a screen that needs
  the whole run must fetch it with `runs.list`.
- The run files and the YAML format are unchanged.
