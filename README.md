# paseo-playbooks

Paseo plugin that makes an agent pick a playbook and run each step as a subagent, through
to the human gates. See [OVERVIEW.md](OVERVIEW.md) for what it does and
[docs/adrs/2026-11-02-design.md](docs/adrs/2026-11-02-design.md) for the design.

## Layout

| Path | Contents |
| --- | --- |
| `index.server.ts`, `server/` | Daemon side: YAML loader and validator, run engine, run store, agent tools, hooks, RPC handlers |
| `index.client.tsx`, `client/` | The Playbooks panel (graph, node sheet, Start form) and the cap settings screen |
| `shared/` | Zod types, RPC contracts, graph and template helpers |
| `examples/.paseo/plugins/playbooks/` | Example PR playbook and its five roles (not loaded by the plugin) |
| `skills/paseo-playbooks/SKILL.md` | Agent skill for writing playbooks; copy or symlink it into a repo's `.agents/skills/` or `.claude/skills/` |

## Develop

```bash
npm install
npm run typecheck
npm test
```

Install on a local daemon from a stable checkout (not a Paseo worktree, which can be
archived), then reload after each change:

```bash
paseo plugin install "$PWD"
paseo plugin reload paseo-playbooks
paseo plugin logs paseo-playbooks
```

To use playbooks in a repository, copy `examples/.paseo/plugins/playbooks/` into it (as
`.paseo/plugins/playbooks/` or `.paseo/playbooks/`),
adjust the roles and playbooks, commit them, and allow the modes they use in
Settings → Plugins → paseo-playbooks. Then open the Playbooks panel in a workspace of
that repository and press Start.
