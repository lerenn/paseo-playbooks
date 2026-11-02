/** Minimal step shape for graph algorithms. */
export interface GraphNode {
  id: string;
  needs: readonly string[];
}

/** Returns one cycle (as a list of ids) if `needs` has one, else null. Unknown needs are ignored. */
export function findCycle(nodes: readonly GraphNode[]): string[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (!byId.has(need)) continue;
      const cycle = visit(need);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/** All transitive `needs` of a step. Assumes an acyclic graph. */
export function ancestorsOf(nodes: readonly GraphNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result = new Set<string>();
  const pending = [...(byId.get(id)?.needs ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (result.has(next) || !byId.has(next)) continue;
    result.add(next);
    pending.push(...byId.get(next)!.needs);
  }
  return result;
}

/** All steps that transitively need `id`. */
export function descendantsOf(nodes: readonly GraphNode[], id: string): Set<string> {
  const result = new Set<string>();
  let frontier = [id];
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const node of nodes) {
      if (result.has(node.id)) continue;
      if (node.needs.some((need) => frontier.includes(need))) {
        result.add(node.id);
        nextFrontier.push(node.id);
      }
    }
    frontier = nextFrontier;
  }
  return result;
}

/** Layer index per step: one below its deepest need. Roots are layer 0. */
export function layerOf(nodes: readonly GraphNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const layers = new Map<string, number>();
  const compute = (id: string, guard: Set<string>): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (guard.has(id)) return 0;
    guard.add(id);
    const needs = (byId.get(id)?.needs ?? []).filter((need) => byId.has(need));
    const layer = needs.length === 0 ? 0 : Math.max(...needs.map((need) => compute(need, guard))) + 1;
    layers.set(id, layer);
    return layer;
  };
  for (const node of nodes) compute(node.id, new Set());
  return layers;
}

export interface GraphLayout {
  /** Step ids per layer, top to bottom, in file order within a layer. */
  layers: string[][];
  /** For each layer boundary i (between layer i and i+1): edges crossing it. */
  edges: Array<{ from: string; to: string }>;
}

/** Top-down layered layout used by the panel. Order inside a layer follows the file. */
export function layoutGraph(nodes: readonly GraphNode[]): GraphLayout {
  const layerIndex = layerOf(nodes);
  const depth = nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => layerIndex.get(node.id) ?? 0)) + 1;
  const layers: string[][] = Array.from({ length: depth }, () => []);
  for (const node of nodes) layers[layerIndex.get(node.id) ?? 0]!.push(node.id);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = nodes.flatMap((node) =>
    node.needs.filter((need) => ids.has(need)).map((need) => ({ from: need, to: node.id })),
  );
  return { layers, edges };
}

/** Ids of the synthetic Start and End nodes the panel draws around a playbook. */
export const START = "__start";
export const END = "__end";

/** Adds Start (needed by every root step) and End (needing every step that nothing needs). */
export function withTerminals(nodes: readonly GraphNode[]): GraphNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const needed = new Set(nodes.flatMap((node) => node.needs.filter((need) => ids.has(need))));
  const steps = nodes.map((node) => {
    const needs = node.needs.filter((need) => ids.has(need));
    return { id: node.id, needs: needs.length === 0 ? [START] : needs };
  });
  const sinks = nodes.filter((node) => !needed.has(node.id)).map((node) => node.id);
  return [{ id: START, needs: [] }, ...steps, { id: END, needs: nodes.length === 0 ? [START] : sinks }];
}
