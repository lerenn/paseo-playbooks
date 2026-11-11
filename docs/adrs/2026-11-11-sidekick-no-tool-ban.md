# Sidekick: drop the disallowed-tools ban

## Status

Accepted

## Context

The plugin launched each Sidekick with `disallowedTools` set to `Bash`, `Edit`, `Write` and `NotebookEdit`, so that it could only coordinate. The Paseo daemon copies the caller's provider options, `disallowedTools` included, to every same-provider child created with `create_agent`. Every Sidekick subagent therefore had no shell and no file tools, and could not do the work it was created for.

## Decision

The plugin no longer sets `disallowedTools` on the Sidekick. The `allowedTools` pre-approval stays. The Sidekick's prompt says it must never edit a file or run a shell command itself and must hand all of that to subagents.

The prompt also says where subagents are created: a job about a run goes to that run's workspace (visible to the human), a job about playbooks, roles or scripts to a visible existing project workspace, never to the Sidekick's own hidden workspace; in a run's workspace a subagent works in its own git worktree on a new branch so the run's files are left alone.

This supersedes the tool-ban rule stated in `2026-11-10-sidekick.md` and `2026-11-10-sidekick-per-project.md`; the rest of those decisions stands.

## Consequences

- The Sidekick is restricted only by its prompt, not by the daemon.
- A Sidekick already running keeps the old config (and its subagents stay without tools) until it is restarted with the column's restart button.
- An alternative is a fix upstream in Paseo, so that child agents do not inherit `disallowedTools`; the ban could then return. Not done here.
