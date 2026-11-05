# Playbooks screen: a Runs heading with a sort per playbook

Status: Accepted.

## Context

Each playbook's table on the Playbooks screen had an empty cell above its run titles, and its
runs only came in order of last update.

## Decision

- That cell holds a **Runs** heading and a sort menu, one per playbook: **Last update** (the
  default), **Started** (newest first), **Status** (waiting, working, failed, done, paused,
  seen) and **Progress** (share of the line covered, furthest first). Ties go to the most
  recent update.
- The choice lives in the screen's memory and resets when it is reopened. On compact layouts the
  header row shows only the heading and the menu.
- The step columns still come from the playbook's most recently updated run, whatever the sort.

## Consequences

- Long playbooks can show what needs a look, or what is furthest along, first.
- The sort is not saved; saving it would need client state the SDK does not offer for screens.
