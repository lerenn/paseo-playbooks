import { SIDEKICK_PROMPT_START } from "../../shared/sidekick-marker";
import type { Item } from "./reduce";

/** The text of the first user message is the plugin's own prompt to the Sidekick, not something the human wrote. */
export function isInstructionsMessage(text: string): boolean {
  return text.trimStart().startsWith(SIDEKICK_PROMPT_START);
}

/** Marks the first user message of a timeline as the instructions when it is the plugin's prompt. */
export function markInstructions(items: Item[]): Item[] {
  const first = items.findIndex((item) => item.kind === "user");
  const item = items[first];
  if (!item || item.kind !== "user" || item.instructions || !isInstructionsMessage(item.text)) return items;
  const next = items.slice();
  next[first] = { ...item, instructions: true };
  return next;
}

const PLUGIN_PREFIX = "[playbooks]";

/**
 * A message the plugin sent to the Sidekick (it starts with "[playbooks]"): a one-line summary to show closed
 * (its first line, plus the kinds of the events it lists), and the body to show opened. Null for anything else.
 */
export function pluginMessage(text: string): { summary: string; body: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(PLUGIN_PREFIX)) return null;
  const body = trimmed.slice(PLUGIN_PREFIX.length).trim();
  const first = (body.split("\n", 1)[0] ?? "").replace(/:$/, "");
  const kinds = [...new Set([...body.matchAll(/^- ([a-z]+(?:\.[a-z_]+)+):/gm)].map((match) => match[1]!))];
  return { summary: kinds.length > 0 ? `${first} (${kinds.join(", ")})` : first, body };
}
