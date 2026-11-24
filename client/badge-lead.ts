/** Our badges in the order they appear on a row. */
export const BADGE_ORDER = ["playbook-run", "playbook-state", "playbook-attention"] as const;
export type BadgeItemId = (typeof BADGE_ORDER)[number];

/** The badge that carries the row's leading separator: the first of `rendered` in BADGE_ORDER, null when none renders. */
export function leadingBadge(rendered: ReadonlySet<BadgeItemId> | undefined): BadgeItemId | null {
  if (!rendered) return null;
  return BADGE_ORDER.find((id) => rendered.has(id)) ?? null;
}

/**
 * Which of our badges render on each workspace row. A badge registers while it renders something (a hidden
 * item, or one with nothing to say, does not), so the "·" goes to the first visible one and a row never
 * shows two.
 */
export interface LeadRegistry {
  subscribe(listener: () => void): () => void;
  /** Counted, so that a badge remounted before its old registration is cleaned up stays registered. */
  register(workspaceId: string, id: BadgeItemId): () => void;
  lead(workspaceId: string): BadgeItemId | null;
}

export function createLeadRegistry(): LeadRegistry {
  const listeners = new Set<() => void>();
  const rendered = new Map<string, Map<BadgeItemId, number>>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    register(workspaceId, id) {
      const counts = rendered.get(workspaceId) ?? new Map<BadgeItemId, number>();
      rendered.set(workspaceId, counts);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      notify();
      return () => {
        const left = (counts.get(id) ?? 1) - 1;
        if (left > 0) counts.set(id, left);
        else counts.delete(id);
        if (counts.size === 0) rendered.delete(workspaceId);
        notify();
      };
    },
    lead: (workspaceId) => leadingBadge(rendered.get(workspaceId) && new Set(rendered.get(workspaceId)!.keys())),
  };
}
