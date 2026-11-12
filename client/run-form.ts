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

export interface RunProject {
  projectId: string;
  label: string;
  /** The workspace the project's playbooks are listed and started from: its first one. */
  workspaceId: string;
}

/** One entry per project, each with its first workspace, sorted by label. */
export function projectsOf(workspaces: readonly { id: string; projectId: string; projectLabel: string }[]): RunProject[] {
  const byProject = new Map<string, RunProject>();
  for (const workspace of workspaces) {
    if (!byProject.has(workspace.projectId)) byProject.set(workspace.projectId, { projectId: workspace.projectId, label: workspace.projectLabel, workspaceId: workspace.id });
  }
  return [...byProject.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The project the Run Playbook form starts on: the selected chip when it can run something, the only candidate, else none (the human must choose). */
export function defaultProject(candidates: readonly RunProject[], chip: string | null): string | null {
  if (chip && candidates.some((candidate) => candidate.projectId === chip)) return chip;
  return candidates.length === 1 ? candidates[0]!.projectId : null;
}

/** The Run Playbook button state: shown once a project has a runnable playbook; while the lists load it is shown disabled, so it does not appear late. */
export function runButtonState(runnableProjects: number, loading: boolean): "hidden" | "loading" | "ready" {
  if (runnableProjects > 0) return "ready";
  return loading ? "loading" : "hidden";
}
