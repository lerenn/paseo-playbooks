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

/** The `{input}` placeholders of a `workspace.title` template, in order of appearance. */
export function workspaceTitleRefs(template: string): string[] {
  return [...template.matchAll(TITLE_PLACEHOLDER)].map((match) => match[1]!);
}

const TITLE_PLACEHOLDER = /\{([A-Za-z_][\w-]*)\}/g;

/**
 * The template filled from the run's inputs, or null when it cannot be filled completely: a placeholder names an
 * input the run does not have, or one that is empty. The caller then keeps the default title.
 */
function fillTitle(template: string, inputs: Record<string, unknown>): string | null {
  let complete = true;
  const text = template.replace(TITLE_PLACEHOLDER, (_whole, name: string) => {
    const value = inputs[name];
    const rendered = value === undefined || value === null ? "" : typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (rendered.trim() === "") complete = false;
    return rendered;
  });
  return complete ? text : null;
}

/**
 * The title of a run's new workspace, the one place it is computed. In order: the name chosen by the caller
 * (`start_playbook`'s `workspaceName`), the playbook's `workspace.title` filled from the run's inputs (when it
 * can be filled completely), else `<playbook title>: <headline of the inputs>`. Each is cut to one line of at most 80 characters.
 */
export function workspaceTitle(playbookTitle: string, inputs: Record<string, unknown>, workspaceName?: string | null, template?: string | null): string {
  const chosen = sanitizeWorkspaceName(workspaceName);
  if (chosen) return chosen;
  const filled = template ? sanitizeWorkspaceName(fillTitle(template, inputs)) : undefined;
  if (filled) return filled;
  const headline = String(inputs.request ?? Object.values(inputs)[0] ?? "").slice(0, 60);
  return `${playbookTitle}${headline ? `: ${headline}` : ""}`;
}
