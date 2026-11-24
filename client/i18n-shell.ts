/** The "shell" catalogue fragment, merged into client/i18n.ts under the `shell` key. English is the source. */
export const shellEn = {
  badge: {
    // The two items' names in the sidebar's Show menu.
    runTitle: "Playbook run",
    stateTitle: "Playbook state",
    attentionTitle: "Playbook needs you",
    // The row's labels stay very short: the line truncates and never wraps.
    steps: "{{done}}/{{total}}",
    state: { done: "done", failed: "failed", canceled: "canceled" },
    stateWord: { ready: "ready", running: "running", paused: "paused", waiting: "waiting" },
    stateFull: { ready: "ready for jobs", running: "running", waiting: "waiting for you or a free slot", held: "paused by rate limiting", paused: "paused", done: "done", failed: "failed", canceled: "canceled" },
    runLabel: "Playbook {{playbook}}: {{state}}, {{done}} of {{total}} steps done",
    runLabelIdle: "Playbook {{playbook}}: {{state}}",
    attention: { gate: "gate", slow: "slow" },
    attentionFull: { gate: "a gate waits for your decision", slow: "a step is slower than usual" },
    attentionLabel: "Playbook needs you: {{reason}}",
  },
} as const;
export const shellFr = {
  badge: {
    runTitle: "Run de playbook",
    stateTitle: "Playbook : état",
    attentionTitle: "Playbook : votre action",
    steps: "{{done}}/{{total}}",
    state: { done: "fini", failed: "échec", canceled: "annulé" },
    stateWord: { ready: "prêt", running: "en cours", paused: "pause", waiting: "attente" },
    stateFull: { ready: "prêt pour des jobs", running: "en cours", waiting: "en attente de vous ou d'une place libre", held: "en pause (limitation de débit)", paused: "en pause", done: "terminé", failed: "échoué", canceled: "annulé" },
    runLabel: "Playbook {{playbook}} : {{state}}, {{done}} étapes sur {{total}} terminées",
    runLabelIdle: "Playbook {{playbook}} : {{state}}",
    attention: { gate: "validation", slow: "lent" },
    attentionFull: { gate: "une validation attend votre décision", slow: "une étape est plus lente que d'habitude" },
    attentionLabel: "Playbook, votre action : {{reason}}",
  },
} as const;
export const shellZh = {
  badge: {
    runTitle: "Playbook 运行",
    stateTitle: "Playbook 状态",
    attentionTitle: "Playbook 需要你处理",
    steps: "{{done}}/{{total}}",
    state: { done: "完成", failed: "失败", canceled: "已取消" },
    stateWord: { ready: "就绪", running: "运行中", paused: "已暂停", waiting: "等待中" },
    stateFull: { ready: "可接收任务", running: "运行中", waiting: "等待你处理或空闲名额", held: "因限速已暂停", paused: "已暂停", done: "已完成", failed: "已失败", canceled: "已取消" },
    runLabel: "Playbook {{playbook}}：{{state}}，已完成 {{done}}/{{total}} 步",
    runLabelIdle: "Playbook {{playbook}}：{{state}}",
    attention: { gate: "审批", slow: "较慢" },
    attentionFull: { gate: "有审批关卡等待你决定", slow: "有步骤比平时慢" },
    attentionLabel: "Playbook 需要你处理：{{reason}}",
  },
} as const;
