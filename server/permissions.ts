import type { PermissionPolicy } from "../shared/types";
import { GATE_SUMMARY_MAX } from "../shared/gates";

/** The part of an agent's permission request the plugin reads. */
export interface PermissionRequestLike {
  id: string;
  name: string;
  kind: string;
  title?: string | undefined;
  description?: string | undefined;
  input?: unknown;
  detail?: unknown;
}

/** The command or target of a tool permission request, as one line when the provider says it. */
function target(request: PermissionRequestLike): string {
  const detail = request.detail as { command?: unknown; filePath?: unknown; path?: unknown } | undefined;
  const input = request.input as { command?: unknown; file_path?: unknown; path?: unknown } | undefined;
  for (const value of [detail?.command, input?.command, detail?.filePath, input?.file_path, detail?.path, input?.path, request.title, request.description]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** What the run history and the gate say about a request: the tool, the command, and who asked. */
export function describePermission(request: PermissionRequestLike, who: string): { tool: string; summary: string; details: string } {
  const what = target(request);
  const summary = `${who} asks to use ${request.name}${what ? `: ${what.split("\n")[0]}` : ""}`;
  return {
    tool: request.name,
    summary: summary.length > GATE_SUMMARY_MAX ? `${summary.slice(0, GATE_SUMMARY_MAX - 1)}…` : summary,
    details: [`Agent: ${who}.`, `Tool: ${request.name}.`, what ? `Command or target:\n${what}` : "", request.description && request.description !== what ? request.description : ""].filter(Boolean).join("\n\n"),
  };
}

/** What a denied agent reads. */
export const DENY_MESSAGE =
  "The plugin refused this request (permissions.on_request: deny). Do not retry it as it is: pick another way, with simple separate commands (no `cd && sed -i && rm -rf` chains, no `rm -rf` globs) and the file tools for edits.";

export function policyText(policy: PermissionPolicy): string {
  return `permissions.on_request: ${policy}`;
}
