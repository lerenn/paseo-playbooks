Playbooks lets one Paseo agent, the Playbook Manager, run a multi-step playbook: each step
runs as a subagent in the same worktree, and the run stops at human gates that you approve
or reject in Paseo.

Playbooks are YAML files in each repository, under `.paseo/plugins/playbooks/`, with
shared roles in `roles/<id>/` (settings and a Markdown system prompt) and optional agent
defaults in `defaults/main.yaml`. Steps form a graph through `needs`: steps that are ready
together run in parallel, loops are explicit `goto` steps back with a limit, and inputs
and outputs are typed and matched by name.

The plugin owns the rules: it validates playbooks, refuses steps or transitions that a
playbook does not allow, keeps each run's state on the daemon so runs survive a restart,
wakes the manager when a step finishes, and enforces read-only roles with a git check. The
manager only makes judgment calls: briefing steps, reading results and choosing outcomes.

The Playbooks panel, in the right-hand sidebar of a workspace, shows each playbook as a
graph. When a run is in progress, nodes show their live status, the running step pulses,
and pressing a node opens that step's conversation. Gates show Approve and Reject buttons.
Start opens a form built from the playbook's inputs, creates a worktree on a new branch,
and starts a manager there.

Settings: Settings → Plugins → paseo-playbooks lists the agent modes playbooks may use per
provider. By default only `default` and `acceptEdits` are allowed for Claude; allow
`bypassPermissions` if you want steps to run unattended. Repositories cannot raise this.

Agents get tools from the plugin: every agent gets `validate_playbooks`; agents in a
workspace with playbooks get the manager tools; step agents get `report_step_result`. The
repository also ships an agent skill, `skills/paseo-playbooks/SKILL.md`, that teaches
agents to write playbooks.

Requires Paseo 0.14. Run state is stored in `$PASEO_HOME/plugin-data/paseo-playbooks/` and
deleted when the run's worktree is archived. Server code runs `git` in workspace folders.
