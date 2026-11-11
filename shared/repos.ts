import type { PlaybookEntry } from "./types";

/** The repository of the playbooks folders themselves: always active, never listed in the config. */
export const DEFAULT_REPO = "default";

/** The id without its repository: `louis:deploy` → `deploy`. */
export function bareId(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

/**
 * The entry a user or agent means by `ref`: a qualified id (`louis:deploy`, `default:deploy`) names one entry;
 * a bare id (`deploy`) must match exactly one repository, and an ambiguous one is an error, never a pick.
 */
export function findEntry(entries: readonly PlaybookEntry[], ref: string): { entry: PlaybookEntry } | { error: string } | { entry: undefined } {
  if (ref.includes(":")) return { entry: entries.find((entry) => qualified(entry) === ref) };
  const matches = entries.filter((entry) => bareId(entry.id) === ref);
  if (matches.length <= 1) return { entry: matches[0] };
  return { error: `playbook "${ref}" is ambiguous: it exists in several repositories; write ${matches.map((entry) => `\`${qualified(entry)}\``).join(" or ")}` };
}

/** `default:deploy`, `louis:deploy`. */
export function qualified(entry: Pick<PlaybookEntry, "id" | "repo">): string {
  return `${entry.repo}:${bareId(entry.id)}`;
}
