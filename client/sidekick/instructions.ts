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
