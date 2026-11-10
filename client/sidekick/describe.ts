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

const KNOWN: Record<string, { sentence: string; keys: string[] }> = {
  create_agent: { sentence: "start a subagent", keys: ["title", "provider", "model", "workspaceId"] },
  send_agent_prompt: { sentence: "send a message to an agent", keys: ["agentId", "prompt"] },
  archive_agent: { sentence: "archive an agent", keys: ["agentId"] },
  update_agent: { sentence: "rename this conversation", keys: ["name", "title"] },
  cancel_agent: { sentence: "cancel an agent's turn", keys: ["agentId"] },
  kill_agent: { sentence: "stop an agent", keys: ["agentId"] },
  set_agent_mode: { sentence: "change an agent's mode", keys: ["agentId", "modeId"] },
  cancel_run: { sentence: "cancel a run", keys: ["runId"] },
  restart_run: { sentence: "restart a run", keys: ["runId"] },
  subscribe_events: { sentence: "subscribe to run events", keys: ["events", "filter"] },
  unsubscribe_events: { sentence: "unsubscribe from run events", keys: ["subscriptionId"] },
  list_runs: { sentence: "list the runs", keys: [] },
  get_run: { sentence: "read a run", keys: ["runId"] },
  list_gates: { sentence: "list the gates", keys: [] },
  validate_playbooks: { sentence: "validate the playbooks", keys: [] },
  Bash: { sentence: "run a shell command", keys: ["command"] },
  Edit: { sentence: "edit a file", keys: ["file_path"] },
  Write: { sentence: "write a file", keys: ["file_path"] },
  NotebookEdit: { sentence: "edit a notebook", keys: ["notebook_path"] },
};

export function describePermission(name: string | undefined, input: unknown): Described {
  const toolId = name ?? "unknown tool";
  const short = shortToolName(toolId);
  const known = KNOWN[short];
  const fields = input && typeof input === "object" ? (input as Input) : {};
  if (!known) return { sentence: `The Sidekick wants to use ${short}`, summary: pick(fields, ["name", "title", "agentId", "runId", "path"]), toolId };
  const summary = short === "Bash" ? text(fields.command) : pick(fields, known.keys);
  return { sentence: `The Sidekick wants to ${known.sentence}`, summary, toolId };
}
