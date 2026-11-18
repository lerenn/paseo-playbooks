# Workspace lookups share one cached list

Status: Accepted

## Context

Every workspace lookup of the plugin was `paseo.workspaces.ref(id).refresh()`. The SDK implements it by
paging the daemon's whole `fetchWorkspaces` list (limit 200) until the id matches: no cache, no by-id
request. Each page makes the daemon rebuild every workspace descriptor. Under load (a few hundred workspaces,
many runs, the panel polling) the plugin sent 2 to 4 `fetch_workspaces` per second with about 15 in flight, so
its own RPCs (`playbooks.list`, ...) exceeded the daemon's 30 s plugin RPC timeout.

## Decision

- `server/workspace-lookup.ts`: one `WorkspaceLookup` per runtime. One fetch of the full list serves every id.
  Concurrent lookups share the fetch in flight (single-flight); the list is kept for 15 s.
- A lookup of an id that is not in a cached list (a workspace created elsewhere) may fetch again, at most once
  per 3 s. After that, the answer is null, as before.
- The cache is dropped when the plugin creates or archives a workspace and on the `workspace.created` and
  `workspace.archived` events. A fetch started before a drop does not fill the cache.
- Not found and errors behave as before: `null` for an unlisted workspace (callers throw their own `UserError`),
  a rejection when the daemon cannot be asked (never cached).
- Every `workspaces.ref(id).refresh()` of `server/runtime.ts` and `index.server.ts` goes through
  `Runtime.lookupWorkspace`. `workspaces.ref(id).agents.create` and the agent refreshes are unchanged.

## Consequences

A workspace's descriptor can be up to 15 s old (title, branch, directory). The fields the plugin reads
(`projectId`, `projectRootPath`, `workspaceDirectory`, `projectDisplayName`) do not change for a workspace's life.
A workspace archived by something other than the plugin is dropped from the cache by the `workspace.archived` event.
The plugin has no workspace rename call; if one is added, invalidate after it.

## Review amendments

- The background-workspace filter falls back to the plain list only on the client's own "Update the host to use
  background workspaces." error (the host lacks the feature). Every other failure propagates and nothing is cached:
  the plain list omits hidden Sidekick workspaces, and a partial list had let the cross-project guard be skipped.
- A throttled miss is uncertain, not "does not exist". `lookupWorkspace` (start, restart, "gone" reports, auto-archive,
  Sidekick reuse) confirms a miss with a fresh fetch; `peekWorkspace` keeps the 3 s throttle for hot panel reads. A hit
  is never refetched, so the flood fix is unchanged.
- `startPlaybookInWorkspace` fails closed when the caller's own workspace/project cannot be determined.
