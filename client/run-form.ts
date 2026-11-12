import type { Playbook, PlaybookEntry } from "../shared/types";

/** The playbooks the Run Playbook form offers: valid ones that start in a workspace (a singleton runs as its own pipeline). */
export function runnablePlaybooks(entries: readonly PlaybookEntry[]): Playbook[] {
  return entries.flatMap((entry) => (entry.playbook && entry.errors.length === 0 && !entry.playbook.singleton ? [entry.playbook] : []));
}

/** What is wrong with the form's input values, by input name: a required input left empty, a number that is not one. */
export function inputErrors(playbook: Playbook, values: Record<string, string | boolean>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [name, def] of Object.entries(playbook.inputs)) {
    const value = values[name];
    const empty = value === undefined || value === "" || (typeof value === "string" && value.trim() === "");
    if (def.type === "boolean") continue;
    if (empty) {
      if (def.required && def.default === undefined) errors[name] = "Required";
    } else if (def.type === "number" && !Number.isFinite(Number(value))) errors[name] = "Must be a number";
  }
  return errors;
}
