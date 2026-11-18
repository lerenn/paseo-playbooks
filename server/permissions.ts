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

/** What the plugin reads of an AskUserQuestion-style request: its questions, each with its options. */
function questionsOf(request: PermissionRequestLike): Array<{ text: string; options: Array<{ label: string; description: string }>; multi: boolean }> {
  const list = (request.input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(list)) return [];
  const out: Array<{ text: string; options: Array<{ label: string; description: string }>; multi: boolean }> = [];
  for (const item of list) {
    const raw = item as { question?: unknown; options?: unknown; multiSelect?: unknown } | null;
    const text = typeof raw?.question === "string" ? raw.question.trim() : "";
    if (!text) continue;
    const options = (Array.isArray(raw?.options) ? raw.options : []).flatMap((option: unknown) => {
      const o = option as { label?: unknown; description?: unknown } | string | null;
      const label = (typeof o === "string" ? o : typeof o?.label === "string" ? o.label : "").trim();
      return label ? [{ label, description: typeof o === "object" && o && typeof o.description === "string" ? o.description.trim() : "" }] : [];
    });
    out.push({ text, options, multi: raw?.multiSelect === true });
  }
  return out;
}

/**
 * What a `manager_question` gate shows for the manager's open question: the question as the summary, its options in the
 * details, and the data the panel answers from. Null when the request has no readable question.
 */
export function describeQuestion(request: PermissionRequestLike, who: string): { tool: string; summary: string; details: string; question: { text: string; options: Array<{ label: string; description: string }>; answerable: boolean } } | null {
  const questions = questionsOf(request);
  const first = questions[0];
  if (!first) return null;
  const answerable = questions.length === 1 && !first.multi;
  const summary = first.text.length > GATE_SUMMARY_MAX ? `${first.text.slice(0, GATE_SUMMARY_MAX - 1)}…` : first.text;
  const shown = questions
    .map((q) => [questions.length > 1 || q.text.length > GATE_SUMMARY_MAX ? q.text : "", q.multi ? "(several answers allowed)" : "", ...q.options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`)].filter(Boolean).join("\n"))
    .join("\n\n");
  const details = [
    `Asked by ${who}, in its own conversation too: answering here or there answers it once.`,
    shown,
    answerable ? "" : "Several questions, or several answers allowed: answer in the manager's conversation (the manager button on the run).",
  ].filter(Boolean).join("\n\n");
  return { tool: request.name, summary, details, question: { text: first.text, options: first.options, answerable } };
}
