import type { GraphNode } from "./graph";
import type { StepStatus } from "./types";

/** What the run view needs to know about the steps of one sub-playbook (nested ones included). */
export interface BlockStats {
  total: number;
  /** Completed or skipped. */
  done: number;
  running: number;
  /** Ready, waiting on a human or a slot, reported, or failed: someone may have to act. */
  attention: number;
  failed: number;
  /** Earliest start of any attempt of its steps (ISO), for the live elapsed time; null when none started. */
  startedAt: string | null;
}

export type BlockStatus = "pending" | "running" | "waiting" | "failed" | "completed";

const ATTENTION: ReadonlySet<StepStatus> = new Set(["ready", "running", "reported", "waiting", "queued", "failed"]);

export interface StepProgress {
  status: StepStatus;
  /** Start times of its attempts. */
  startedAt: readonly (string | undefined)[];
}

/** Steps that belong to `prefix` ("pr" owns "pr.build" and "pr.checks.lint"). */
export function inBlock(prefix: string, stepId: string): boolean {
  return stepId.startsWith(`${prefix}.`);
}

export function blockStats(prefix: string, stepIds: readonly string[], progress: (id: string) => StepProgress | undefined): BlockStats {
  const stats: BlockStats = { total: 0, done: 0, running: 0, attention: 0, failed: 0, startedAt: null };
  for (const id of stepIds) {
    if (!inBlock(prefix, id)) continue;
    stats.total += 1;
    const step = progress(id);
    if (!step) continue;
    if (step.status === "completed" || step.status === "skipped") stats.done += 1;
    if (step.status === "running") stats.running += 1;
    if (step.status === "failed") stats.failed += 1;
    if (ATTENTION.has(step.status)) stats.attention += 1;
    for (const started of step.startedAt) {
      if (started && (stats.startedAt === null || Date.parse(started) < Date.parse(stats.startedAt))) stats.startedAt = started;
    }
  }
  return stats;
}

export function blockStatus(stats: BlockStats): BlockStatus {
  if (stats.failed > 0) return "failed";
  if (stats.running > 0) return "running";
  if (stats.attention > 0) return "waiting";
  if (stats.total > 0 && stats.done === stats.total) return "completed";
  return "pending";
}

/** "3/5 steps" */
export function progressText(stats: BlockStats): string {
  return `${stats.done}/${stats.total} step${stats.total === 1 ? "" : "s"}`;
}

/**
 * What the user chose by hand, and what was already shown open because it needed attention, for one run
 * (both only in memory). A group is shown collapsed unless one of these says otherwise:
 * - a manual choice always wins;
 * - else it is open when a step inside needs attention now, or did at some earlier time (`seen`): the view
 *   only ever opens a group by itself, never closes one the user may be looking at;
 * - with no run (the definition) nothing is running, and the structure is what there is to read: open.
 */
export interface CollapseState {
  manual: Readonly<Record<string, boolean>>;
  seen: readonly string[];
}

export const EMPTY_COLLAPSE: CollapseState = { manual: {}, seen: [] };

export function isCollapsed(prefix: string, stats: BlockStats, state: CollapseState, hasRun: boolean): boolean {
  const manual = state.manual[prefix];
  if (manual !== undefined) return manual;
  if (!hasRun) return false;
  return !(stats.attention > 0 || state.seen.includes(prefix));
}

/** The state after the groups that now need attention are recorded as opened; the same object when nothing changes. */
export function markSeen(state: CollapseState, stats: Readonly<Record<string, BlockStats>>): CollapseState {
  const added = Object.keys(stats).filter((prefix) => stats[prefix]!.attention > 0 && !state.seen.includes(prefix));
  return added.length === 0 ? state : { ...state, seen: [...state.seen, ...added] };
}

export function toggled(state: CollapseState, prefix: string, collapsed: boolean): CollapseState {
  return { ...state, manual: { ...state.manual, [prefix]: !collapsed } };
}

/** Id of the single node standing for a collapsed sub-playbook; it sits inside its parents' frames. */
export function groupNodeId(prefix: string): string {
  return `${prefix}.__block`;
}

export interface Collapsed {
  nodes: GraphNode[];
  /** The node showing a step: the collapsed group around it (the outermost one), else the step itself. */
  nodeOf(stepId: string): string;
  /** Collapsed group node id → its prefix. */
  prefixes: ReadonlyMap<string, string>;
}

/**
 * The graph with every collapsed sub-playbook (the outermost of nested ones) as one node: it needs what its
 * steps needed from outside, and whatever needed one of its steps needs it. Order follows the first step.
 */
export function collapseNodes(steps: readonly GraphNode[], collapsed: ReadonlySet<string>): Collapsed {
  const outer = (id: string): string | null => {
    let found: string | null = null;
    for (const prefix of collapsed) {
      if (inBlock(prefix, id) && (found === null || prefix.length < found.length)) found = prefix;
    }
    return found;
  };
  const nodeOf = (id: string): string => {
    const prefix = outer(id);
    return prefix === null ? id : groupNodeId(prefix);
  };
  const nodes = new Map<string, { id: string; needs: Set<string> }>();
  const prefixes = new Map<string, string>();
  for (const step of steps) {
    const id = nodeOf(step.id);
    const node = nodes.get(id) ?? { id, needs: new Set<string>() };
    nodes.set(id, node);
    if (id !== step.id) prefixes.set(id, outer(step.id)!);
    for (const need of step.needs) {
      const target = nodeOf(need);
      if (target !== id) node.needs.add(target);
    }
  }
  return { nodes: [...nodes.values()].map((node) => ({ id: node.id, needs: [...node.needs] })), nodeOf, prefixes };
}
