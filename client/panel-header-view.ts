/** What the panel's brand header shows: nothing once dismissed, the icon and title on a compact screen, the tagline too otherwise. */
export function headerParts(input: { compact: boolean; dismissed: boolean }): { visible: boolean; tagline: boolean } {
  return { visible: !input.dismissed, tagline: !input.compact };
}
