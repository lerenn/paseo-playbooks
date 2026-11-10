import { shortToolName } from "./describe";
import type { Item } from "./reduce";

type Tool = Extract<Item, { kind: "tool" }>;

export type GroupState = "failed" | "running" | "completed";

export type ViewItem =
  | { kind: "item"; item: Item }
  | { kind: "tools"; key: string; tools: Tool[]; state: GroupState; label: string };

/** "Checked list_runs, get_run (3)": the distinct short names (at most three), then the number of calls. */
export function groupLabel(tools: Tool[]): string {
  const names = [...new Set(tools.map((tool) => shortToolName(tool.name)))];
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
  return `Checked ${shown} (${tools.length})`;
}

/** A failed call shows on the line first, then a running one. */
export function groupState(tools: Tool[]): GroupState {
  if (tools.some((tool) => tool.status === "failed")) return "failed";
  if (tools.some((tool) => tool.status === "running")) return "running";
  return "completed";
}

/** The items as the chat shows them: consecutive tool calls (no message between them) become one group. */
export function groupTools(items: Item[]): ViewItem[] {
  const out: ViewItem[] = [];
  let run: Tool[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push({ kind: "tools", key: `tools:${run[0]!.key}`, tools: run, state: groupState(run), label: groupLabel(run) });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") run.push(item);
    else {
      flush();
      out.push({ kind: "item", item });
    }
  }
  flush();
  return out;
}
