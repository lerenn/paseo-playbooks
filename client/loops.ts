/** One loop-back outcome of a step: taking it sends the run back to `to`. */
export interface LoopEdge {
  from: string;
  to: string;
  outcome: string;
  count: number;
  max: number | undefined;
}

/** All the loop outcomes of one source step that go back to the same target: drawn as one line. */
export interface LoopGroup {
  key: string;
  from: string;
  to: string;
  edges: LoopEdge[];
  /** The short label on the line: the outcome itself when alone, else "N loops". */
  label: string;
  /** Every outcome is at its limit. */
  exhausted: boolean;
  /** Loops taken so far, over all outcomes. */
  taken: number;
}

/** "blocked: retry · 0/3": an outcome with its running counter. */
export function loopText(edge: LoopEdge): string {
  return `${edge.outcome}${edge.max !== undefined ? ` · ${edge.count}/${edge.max}` : ""}`;
}

export function groupLoops(loops: readonly LoopEdge[]): LoopGroup[] {
  const groups = new Map<string, LoopGroup>();
  for (const edge of loops) {
    const key = `${edge.from}->${edge.to}`;
    const group = groups.get(key) ?? { key, from: edge.from, to: edge.to, edges: [], label: "", exhausted: true, taken: 0 };
    group.edges.push(edge);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const [only] = group.edges;
    group.exhausted = group.edges.every((edge) => edge.max !== undefined && edge.count >= edge.max);
    group.taken = group.edges.reduce((sum, edge) => sum + edge.count, 0);
    group.label = group.edges.length === 1 && only ? loopText(only) : `${group.edges.length} loops${group.taken > 0 ? ` · ${group.taken} taken` : ""}`;
  }
  return [...groups.values()];
}

/** The badge on a looping step: "↩ Target · 2 outcomes · 80 taken" (one outcome: its name and n/max). */
export function badgeText(group: LoopGroup, targetTitle: string): string {
  const [only] = group.edges;
  const middle = group.edges.length === 1 && only ? loopText(only) : `${group.edges.length} outcomes`;
  return `↩ ${targetTitle} · ${middle}${group.edges.length > 1 && group.taken > 0 ? ` · ${group.taken} taken` : ""}`;
}

/** More attempts than this collapse to the last few plus a summary chip. */
export const COLLAPSE_ABOVE = 6;
export const KEEP_LAST = 4;

/** The attempts to show as chips: all of them, or (many attempts, not expanded) only the latest few. */
export function visibleAttempts<T>(attempts: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || attempts.length <= COLLAPSE_ABOVE) return { shown: [...attempts], hidden: 0 };
  return { shown: attempts.slice(-KEEP_LAST), hidden: attempts.length - KEEP_LAST };
}
