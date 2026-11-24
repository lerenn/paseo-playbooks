/** The "shell" catalogue fragment, merged into client/i18n.ts under the `shell` key. English is the source. */
export const shellEn = {
  badge: {
    // The two items' names in the sidebar's Show menu.
    runTitle: "Playbook run",
    attentionTitle: "Playbook needs you",
    // The row's labels stay very short: the line truncates and never wraps.
    steps: "{{done}}/{{total}}",
    state: { held: "held", paused: "paused", done: "done", failed: "failed", canceled: "canceled" },
    stateFull: { running: "running", waiting: "waiting for you or a free slot", held: "held by rate limiting", paused: "paused", done: "done", failed: "failed", canceled: "canceled" },
    runLabel: "Playbook {{playbook}}: {{state}}, {{done}} of {{total}} steps done",
    attention: { gate: "gate", slow: "slow", held: "held" },
    attentionFull: { gate: "a gate waits for your decision", slow: "a step is slower than usual", held: "new steps are held by rate limiting" },
    attentionLabel: "Playbook needs you: {{reason}}",
  },
} as const;
export const shellFr = {
  badge: {
    runTitle: "Run de playbook",
    attentionTitle: "Playbook : votre action",
    steps: "{{done}}/{{total}}",
    state: { held: "retenu", paused: "pause", done: "fini", failed: "échec", canceled: "annulé" },
    stateFull: { running: "en cours", waiting: "en attente de vous ou d'une place libre", held: "retenu par la limitation de débit", paused: "en pause", done: "terminé", failed: "échoué", canceled: "annulé" },
    runLabel: "Playbook {{playbook}} : {{state}}, {{done}} étapes sur {{total}} terminées",
    attention: { gate: "validation", slow: "lent", held: "retenu" },
    attentionFull: { gate: "une validation attend votre décision", slow: "une étape est plus lente que d'habitude", held: "les nouvelles étapes sont retenues par la limitation de débit" },
    attentionLabel: "Playbook, votre action : {{reason}}",
  },
} as const;
export const shellZh = {
  badge: {
    runTitle: "Playbook 运行",
    attentionTitle: "Playbook 需要你处理",
    steps: "{{done}}/{{total}}",
    state: { held: "暂缓", paused: "已暂停", done: "完成", failed: "失败", canceled: "已取消" },
    stateFull: { running: "运行中", waiting: "等待你处理或空闲名额", held: "被限速暂缓", paused: "已暂停", done: "已完成", failed: "已失败", canceled: "已取消" },
    runLabel: "Playbook {{playbook}}：{{state}}，已完成 {{done}}/{{total}} 步",
    attention: { gate: "审批", slow: "较慢", held: "暂缓" },
    attentionFull: { gate: "有审批关卡等待你决定", slow: "有步骤比平时慢", held: "新步骤被限速暂缓" },
    attentionLabel: "Playbook 需要你处理：{{reason}}",
  },
} as const;
