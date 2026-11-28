# Daemon-wide playbook library

## Status

Accepted

## Context

A developer who wants the same workflow in every Paseo project currently needs to copy the definition and its roles into each repository. A project added later needs the same setup.

## Decision

Load an optional playbook library from the plugin data directory's `playbooks/` folder for every project served by that daemon. Require `@global:<id>` to refer to its entries. The prefix is outside the project profile name grammar and preserves the meaning of existing bare and profile-qualified references.

Use the library's roles, defaults, sub-playbooks and scripts with the selected project's normal workspace and permissions. Project git refs are a source of project definitions only. An isolated run of a global playbook uses the definition selected from the library when the run starts.

## Consequences

Adding a file to the daemon library makes it available across projects without repository changes. Each daemon has its own library. Local and global definitions may share a filename. Daemon operators control the library's contents, including executable scripts, which run on the host with the selected workspace as their working directory.
