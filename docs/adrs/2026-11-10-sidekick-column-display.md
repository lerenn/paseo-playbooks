# Sidekick column: display of instructions, permissions and tool calls, and UI state kept across screens

## Status

Accepted

## Context

In the Sidekick column the plugin's first prompt looked like a message the human wrote, permission requests showed a raw tool id, every tool call was a full row, and leaving the Playbooks screen lost the open flag, the tab and the draft.

## Decision

- The first user message that starts with the Sidekick prompt (`shared/sidekick-marker.ts`) renders as one closed "Instructions sent to the Sidekick" line. The prompt no longer asks the agent to rename itself.
- Permission requests read as a sentence (`client/sidekick/describe.ts`); "Allow always" sends the request's own `suggestions` as `updatedPermissions`.
- Consecutive tool calls collapse into one line with a status dot.
- `sidekick.list` output gains `needYou` (gates waiting for a human in the project's non-archived runs), defaulting to 0 so older readers stay valid. A status strip shows "n need you · m working".
- The column's open flag, tab, added projects, width and drafts live in a module-level store (`client/sidekick/ui-state.ts`), in session only.

## Consequences

State survives navigation within a session, not a reload. The RPC change is backward compatible.
