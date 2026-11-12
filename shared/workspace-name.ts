/** Longest workspace title the plugin sets, in characters. */
export const WORKSPACE_NAME_MAX = 80;

/**
 * A user-chosen workspace name as a one-line title: control characters and runs of whitespace become one
 * space, the ends are trimmed, and it is cut at WORKSPACE_NAME_MAX. Empty after that: undefined (use the default).
 * The title never reaches the branch name, which comes from the playbook id and the run id.
 */
export function sanitizeWorkspaceName(raw: string | undefined | null): string | undefined {
  const text = (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim()
    .slice(0, WORKSPACE_NAME_MAX)
    .trim();
  return text || undefined;
}

/** The title of a run's new workspace: the chosen name, else `<playbook title>: <headline of the inputs>`. */
export function workspaceTitle(playbookTitle: string, inputs: Record<string, unknown>, workspaceName?: string | null): string {
  const chosen = sanitizeWorkspaceName(workspaceName);
  if (chosen) return chosen;
  const headline = String(inputs.request ?? Object.values(inputs)[0] ?? "").slice(0, 60);
  return `${playbookTitle}${headline ? `: ${headline}` : ""}`;
}
