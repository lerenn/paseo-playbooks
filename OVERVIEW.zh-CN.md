Playbooks 把多智能体工作流写成一个放在仓库里的 YAML 文件：调研、实现、评审、修复、发布，并在你需要的地方加入人工审批。由一个 Paseo 智能体（Playbook Manager）执行 playbook：每个步骤作为子智能体在同一个 worktree 中运行，流程会在人工审批关卡（gate）处暂停，由你在 Paseo 中批准或拒绝。

Playbook 是每个仓库自己的 YAML 文件，位于 `.paseo/plugins/playbooks/` 或 `.paseo/playbooks/` 下；共享角色放在 `roles/<id>/` 中（设置和一份 Markdown 系统提示词），可选的智能体默认配置放在 `defaults/main.yaml` 中。步骤通过 `needs` 组成一张图：同时就绪的步骤并行运行，循环是带次数上限的显式 `goto` 回跳，输入和输出带类型并按名称匹配。收尾任务（`after:`，例如一次复盘）在运行完成或失败后执行，也可以由人手动启动，且不会改变运行结果。

规则由插件负责执行：它校验 playbook，拒绝 playbook 不允许的步骤或流转，把每次运行的状态保存在 daemon 上以便重启后继续，在步骤结束时唤醒 manager，并通过 git 检查强制只读角色。manager 只负责需要判断的事情：给步骤下达任务说明、阅读结果、选择结果分支。

Playbooks 面板位于工作区右侧边栏，把每个 playbook 显示为一张图。运行过程中，节点实时显示状态，正在运行的步骤会闪烁，点击节点即可打开该步骤的对话。关卡显示 Approve 和 Reject 按钮。Start 会打开一个根据 playbook 输入生成的表单，并以工作区中最近使用的智能体作为 manager、在其当前分支上运行 playbook。Start 旁边的箭头提供 "Start on a new agent"（在同一工作区新建一个 manager 智能体）和 "Start in a new workspace"（在新分支上创建 worktree 并在其中启动 manager）。在面板中可以暂停、恢复或取消运行，已结束的运行可以从任何依赖已完成的步骤重新开始。

示例 playbook 可以直接复制到 `.paseo/plugins/playbooks/`，见[示例页面](https://playbooks.paseo.lerenn.dev/examples.html)和仓库：一个 pull request 工作流（调研、实现、创建 PR 并持续跟进直到检查通过），一个带 QA 的开发环境发布流程，一个通过人工审批把两者串起来的功能交付 playbook，以及本仓库对自身运行的文档检查，包含并行评审和改写循环。

智能体模式：playbook 可以使用任何模式，包括 `bypassPermissions`，这样运行 shell 命令的步骤可以无人值守地执行。只运行来自可信仓库的 playbook。

插件为智能体提供工具：除步骤智能体外，所有智能体都有 `validate_playbooks`、`list_runs`、`cancel_run` 和 `restart_run`（可以在任何对话中停止运行，或从某个步骤重新开始已结束的运行）；包含 playbook 的工作区中的智能体获得 manager 工具；步骤智能体获得 `report_step_result`。仓库还附带一个智能体技能 `skills/paseo-playbooks/SKILL.md`，用于教智能体编写 playbook。

需要 Paseo 0.14 或更高版本。运行状态保存在 `$PASEO_HOME/plugin-data/paseo-playbooks/runs/`，在运行所在的 worktree 被归档时删除。服务端代码会在工作区目录中运行 `git`。
