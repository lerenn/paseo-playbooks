/** Permission requests in words: "The Sidekick wants to rename this conversation", with the key arguments on one line. */

export interface Described {
  /** The sentence shown on the card. */
  sentence: string;
  /** The key arguments summarised on one line, or null. */
  summary: string | null;
  /** The raw tool id, for a tooltip or small muted text. */
  toolId: string;
}

type Input = Record<string, unknown>;

const text = (value: unknown, max = 80): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const line = value.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "mcp__paseo__update_agent" -> "update_agent"; "mcp__playbooks__cancel_run" -> "cancel_run". */
export function shortToolName(name: string): string {
  const match = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return match ? match[1]! : name;
}

const pick = (input: Input, keys: string[]): string | null => {
  const parts = keys.flatMap((key) => {
    const value = input[key];
    const shown = typeof value === "number" || typeof value === "boolean" ? String(value) : text(value, 60);
    return shown ? [`${key}: ${shown}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
};

/** The translator the helpers need: the panel's `t`, narrowed to the keys used here. */
export type DescribeT = (key: `sidekick.action.${ActionName}` | "sidekick.perm.wants" | "sidekick.perm.wantsUse" | "sidekick.perm.unknownTool" | "sidekick.perm.tool", params?: { action?: string; tool?: string }) => string;

type ActionName = "create_agent" | "send_agent_prompt" | "archive_agent" | "update_agent" | "cancel_agent" | "kill_agent" | "set_agent_mode" | "cancel_run" | "restart_run" | "subscribe_events" | "unsubscribe_events" | "list_runs" | "get_run" | "list_gates" | "resume_gate" | "defer_gate" | "return_gate" | "validate_playbooks" | "Bash" | "Edit" | "Write" | "NotebookEdit";

const KNOWN: Record<string, { keys: string[] }> = {
  create_agent: { keys: ["title", "provider", "model", "workspaceId"] },
  send_agent_prompt: { keys: ["agentId", "prompt"] },
  archive_agent: { keys: ["agentId"] },
  update_agent: { keys: ["name", "title"] },
  cancel_agent: { keys: ["agentId"] },
  kill_agent: { keys: ["agentId"] },
  set_agent_mode: { keys: ["agentId", "modeId"] },
  cancel_run: { keys: ["runId"] },
  restart_run: { keys: ["runId"] },
  subscribe_events: { keys: ["events", "filter"] },
  unsubscribe_events: { keys: ["subscriptionId"] },
  list_runs: { keys: [] },
  get_run: { keys: ["runId"] },
  list_gates: { keys: [] },
  resume_gate: { keys: ["runId", "gateId", "choice"] },
  defer_gate: { keys: ["runId", "gateId", "reason"] },
  return_gate: { keys: ["runId", "gateId"] },
  validate_playbooks: { keys: [] },
  Bash: { keys: ["command"] },
  Edit: { keys: ["file_path"] },
  Write: { keys: ["file_path"] },
  NotebookEdit: { keys: ["notebook_path"] },
};

export function describePermission(t: DescribeT, name: string | undefined, input: unknown): Described {
  const toolId = name ?? t("sidekick.perm.unknownTool");
  const short = shortToolName(toolId);
  const known = Object.hasOwn(KNOWN, short) ? KNOWN[short] : undefined;
  const fields = input && typeof input === "object" ? (input as Input) : {};
  if (!known) return { sentence: t("sidekick.perm.wantsUse", { tool: short }), summary: pick(fields, ["name", "title", "agentId", "runId", "path"]), toolId };
  const summary = short === "Bash" ? text(fields.command) : pick(fields, known.keys);
  return { sentence: t("sidekick.perm.wants", { action: t(`sidekick.action.${short as ActionName}`) }), summary, toolId };
}

/** "mcp__paseo__create_agent" -> "Create agent"; "Bash" -> "Bash"; "ToolSearch" -> "Toolsearch". */
export function humanizeTool(t: DescribeT, name: string): string {
  const words = shortToolName(name).replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : t("sidekick.perm.tool");
}

const SUMMARY_KEYS = ["command", "title", "query", "path", "file_path", "filePath", "url", "name", "description", "prompt", "pattern", "id"];

/** One short line about what a tool call did, from the keys of its detail (or its input), or null. */
export function toolSummary(detail: Record<string, unknown> | null, max = 120): string | null {
  if (!detail) return null;
  const sources = [detail, ...(typeof detail.input === "object" && detail.input ? [detail.input as Input] : [])];
  for (const source of sources) {
    for (const key of SUMMARY_KEYS) {
      const shown = text((source as Input)[key], max);
      if (shown) return shown;
    }
  }
  return null;
}

/** The leading icon of a tool row: a terminal for shell commands, a bot for agents, a wrench otherwise. */
export function toolIcon(name: string): "Terminal" | "Bot" | "Wrench" {
  const short = shortToolName(name).toLowerCase();
  if (/^(bash|shell|exec)|command/.test(short)) return "Terminal";
  if (/agent/.test(short)) return "Bot";
  return "Wrench";
}
