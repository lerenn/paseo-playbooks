# Onboarding: create an example playbook from the empty state

## Status

Accepted

## Context

A new user opens the Playbooks panel and sees "No playbooks in this workspace" with a link to the
guide. They must leave Paseo and write YAML before seeing anything work. The Playbooks screen
dead-ended on "No runs yet." as well.

## Decision

- The panel's empty state offers **Create an example playbook**. After an inline confirmation naming
  the folder, a new RPC `playbooks.create-example` writes `hello.yaml` and a `writer` role into
  `.paseo/plugins/playbooks/` of the workspace. The guide stays a secondary link.
- The server refuses when the workspace already has playbooks, and never overwrites a file
  (`wx` writes). No `defaults/main.yaml` is written, so the user's own agent defaults apply.
- The example is bundled in `server/starter.ts`, so it works offline. It mirrors the one in the
  getting-started guide.
- With no run at all, the Playbooks screen explains where to find the button and links the guide.
  It has no workspace to write into, so it does not create files itself.
- No tour or wizard.

## Consequences

- The plugin's server now writes into the user's repository, but only on an explicit, confirmed
  action, and only into an empty playbooks folder.
- The bundled example must be kept loadable: `server/starter.test.ts` loads it with the real loader.
