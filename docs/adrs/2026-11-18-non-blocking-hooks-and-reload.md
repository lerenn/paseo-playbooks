# Hooks and RPCs never wait for the sweeps or the post-update session reload

Status: Accepted

## Context

After a `paseo plugin update` the Playbooks panel showed "Plugin RPC timed out: paseo-playbooks.invoke"
and "0 need you · 0 working" with about 25 active runs, and the daemon logged 57 "Lifecycle hook ...
failed: Plugin RPC timed out: paseo-playbooks.hook" lines, from the plugin start (18:18:13Z) until the
line "session reload after the plugin update: 77 reloaded ..." (18:20:19Z). After that the plugin
answered normally.

Cause: every hook and RPC entry point (`enter` in `index.server.ts`) awaited `Runtime.attach()`, which
awaits the whole start sequence: reconcile of the runs, the orphan worktree sweep (it removes whole
checkouts, `node_modules` included: more than 30 s in the log), the first tick, and then the reload of
the stale sessions, which was sequential: 77 reloads of about 1.2 s each, 94 s. So for about two
minutes each hook and each RPC waited for all of it and hit the daemon's fixed timeout. It was not the
event loop: `monitorEventLoopDelay` stays at the timer resolution (about 11 ms) during the reload in
the simulation (60 agents, 100 ms per reload), while an entry point took the whole reload (1.5 s) to
answer before the change.

This adjusts `2026-11-09-reload-stale-sessions.md` (when and how the reload runs); none of its rules is
superseded: the same sessions are reloaded under the same safety conditions.

## Decision

- `Runtime.enter()` is the entry point of hooks and RPCs: it starts the reconcile and waits only for its
  first phase (the runs picked up again: timeouts re-armed, lost steps recorded), for at most 3 s.
- The rest runs in the background, in order: the worktree sweep, the permission sweep, admission, the
  first tick, the reload of stale sessions, the re-arming of the subagent archives. `attach()` still
  resolves when everything is done (tests, `agent.session_open`'s fire-and-forget).
- The reload of stale sessions runs 4 sessions at a time, with a 20 ms pause after each, instead of one
  after the other. Which sessions are reloaded, and when they are left alone (busy, asking, waiting
  for a permission, working directory gone), is unchanged.
- The reload ends with a log line that also gives its duration and the largest event-loop delay seen,
  so the next occurrence can be diagnosed.

## Consequences

- Hooks and the panel answer within the budget during and right after an update. A hook that arrives
  before the first phase ends waits at most 3 s, then runs: for a very large state it may overlap the
  end of reconcile, which was the case for a tool call anyway.
- A hook may now run while the sweep or the first tick is in progress; they were already safe against
  concurrent hooks (the tick is serialised, the sweep skips worktrees being created).
- A reload of 77 sessions takes about a quarter of the time. Unchanged: each reload still makes the
  daemon call back into the plugin (session-open hook), now four at a time.
