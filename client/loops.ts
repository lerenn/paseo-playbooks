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

/**
 * A lane (0, 1, ...) for each group, on the right of the graph. Groups whose spans of layers do
 * not overlap share a lane, so there are few lanes however many loops a playbook has.
 */
export function assignLanes(groups: readonly LoopGroup[], layerOf: (id: string) => number): { lanes: Map<string, number>; count: number } {
  const taken: Array<Array<[number, number]>> = [];
  const lanes = new Map<string, number>();
  const spans = groups
    .map((group) => ({ key: group.key, lo: Math.min(layerOf(group.from), layerOf(group.to)), hi: Math.max(layerOf(group.from), layerOf(group.to)) }))
    .sort((a, b) => b.hi - b.lo - (a.hi - a.lo) || a.lo - b.lo);
  for (const span of spans) {
    let lane = taken.findIndex((used) => used.every(([lo, hi]) => span.hi < lo || span.lo > hi));
    if (lane < 0) {
      lane = taken.length;
      taken.push([]);
    }
    taken[lane]!.push([span.lo, span.hi]);
    lanes.set(span.key, lane);
  }
  return { lanes, count: taken.length };
}
