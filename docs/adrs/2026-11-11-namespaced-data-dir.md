# Plugin data directory namespaced by owner

Status: Accepted

## Context

The plugin kept its data (config, runs, worktrees, event files) in `$PASEO_HOME/plugin-data/paseo-playbooks/`.
Another author's plugin with the same name would share that directory and read or overwrite live run files.

## Decision

- The data directory is `$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/`.
- At startup, if the old directory exists and the new one does not, the plugin renames the old one to the new
  one and leaves a symlink at the old path. Paths recorded in run files (isolated worktrees) and older plugin
  versions keep resolving through the link.
- If the move fails, the old directory stays in use until a later start succeeds.

## Consequences

- Active runs and worktrees survive the move with no per-file migration.
- The old path remains as a symlink; it can be removed once no older version is installed.
