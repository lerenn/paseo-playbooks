/** Display form of an id: first letter capitalised ("review" → "Review"). The id itself is unchanged. */
export function stepLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
