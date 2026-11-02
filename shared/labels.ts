/**
 * Display form of an id: its last segment (steps of a sub-playbook are "pr.investigate"),
 * first letter capitalised ("investigate" → "Investigate"). The id itself is unchanged.
 */
export function stepLabel(id: string): string {
  const name = id.slice(id.lastIndexOf(".") + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
