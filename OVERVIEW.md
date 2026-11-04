Playbooks turns a multi-agent workflow into a YAML file that you keep in your repository:
investigate, implement, review, fix, release, with a human approval wherever you want one.
One Paseo agent, the Playbook Manager, runs the playbook: each step runs as a subagent in
the same worktree, and the run stops at human gates that you approve or reject in Paseo.

Playbooks are YAML files in each repository, under `.paseo/plugins/playbooks/` or
`.paseo/playbooks/`, with shared roles in `roles/<id>/` (settings and a Markdown system
prompt) and optional agent defaults in `defaults/main.yaml`. Steps form a graph through `needs`: steps that are ready
together run in parallel, loops are explicit `goto` steps back with a limit, and inputs
and outputs are typed and matched by name. After-tasks (`after:`, a retro for example) run
once the run has completed or failed, or when a human starts them, without changing its result.

The plugin owns the rules: it validates playbooks, refuses steps or transitions that a
playbook does not allow, keeps each run's state on the daemon so runs survive a restart,
wakes the manager when a step finishes, and enforces read-only roles with a git check. The
manager only makes judgment calls: briefing steps, reading results and choosing outcomes.

The Playbooks panel, in the right-hand sidebar of a workspace, shows each playbook as a
graph. When a run is in progress, nodes show their live status, the running step pulses,
and pressing a node opens that step's conversation. Gates show Approve and Reject buttons.
Start opens a form built from the playbook's inputs and runs the playbook with the
workspace's most recent agent as manager, on its current branch. The arrow next to Start
offers "Start on a new agent", which starts a new manager agent in the same workspace,
and "Start in a new workspace", which creates a worktree on a new branch and starts a
manager there. Runs can be paused, resumed or canceled from the panel, and a finished run
can be restarted from any step whose needs completed.

Example playbooks, ready to copy into `.paseo/plugins/playbooks/`, are on the
[examples page](https://louisfradin.com/paseo-playbooks/examples.html) and in the
repository: a pull-request workflow (investigate, implement, open the PR and babysit it
until it is green), a release to a development environment with QA, a capability playbook
that chains both through a human gate, and the documentation check this repository runs on
itself, with parallel reviewers and a rewrite loop.

Agent modes: playbooks may use any mode, `bypassPermissions` included, so steps that run
shell commands work unattended. Only start playbooks from repositories you trust.

Agents get tools from the plugin: every agent except step agents gets `validate_playbooks`,
`list_runs`, `cancel_run` and `restart_run` (so you can stop a run, or restart a finished one
from a step, from any chat);
agents in a workspace with playbooks get the manager tools; step agents get
`report_step_result`. The
repository also ships an agent skill, `skills/paseo-playbooks/SKILL.md`, that teaches
agents to write playbooks.

Requires Paseo 0.14 or later. Run state is stored in `$PASEO_HOME/plugin-data/paseo-playbooks/runs/` and
deleted when the run's worktree is archived. Server code runs `git` in workspace folders.
